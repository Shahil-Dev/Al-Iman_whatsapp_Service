import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import pino from "pino";
import fs from "fs";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5001;
const SECRET_KEY = process.env.MICROSERVICE_SECRET_KEY || "my_super_secret_key_123";

let sock: any = null;
let isConnecting = false;
let pairingRequested = false;
let reconnectTimer: NodeJS.Timeout | null = null;

const clearSessionFolder = () => {
  const authFolderPath = path.join(process.cwd(), "baileys_auth_info");
  if (fs.existsSync(authFolderPath)) {
    try {
      fs.rmSync(authFolderPath, { recursive: true, force: true });
      console.log("🧹 Auth session folder cleared!");
    } catch (err) {
      console.error("Failed to clear session folder:", err);
    }
  }
};

// Helper to safely purge and close active socket
const cleanupSocket = () => {
  if (sock) {
    try {
      sock.ev.removeAllListeners("connection.update");
      sock.ev.removeAllListeners("creds.update");
      sock.end(undefined);
    } catch (e) {
      // Ignore cleanup error if already closed
    }
    sock = null;
  }
};

const connectToWhatsApp = async () => {
  if (isConnecting) {
    console.log("⏳ Connection attempt already in progress, skipping...");
    return;
  }

  isConnecting = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    cleanupSocket();

    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      Browsers,
    } = await import("@whiskeysockets/baileys");

    const authFolderPath = path.join(process.cwd(), "baileys_auth_info");
    const { state, saveCreds } = await useMultiFileAuthState(authFolderPath);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      syncFullHistory: false, // Prevents session overload
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect } = update;

      if (
        connection === "connecting" &&
        !sock?.authState?.creds?.registered &&
        !pairingRequested
      ) {
        pairingRequested = true;
        const rawPhone = process.env.WHATSAPP_PHONE_NUMBER;
        if (rawPhone) {
          let cleanNumber = rawPhone.replace(/\D/g, "");
          if (cleanNumber.startsWith("0")) {
            cleanNumber = `88${cleanNumber}`;
          }
          setTimeout(async () => {
            try {
              if (sock && !sock.authState.creds.registered) {
                const code = await sock.requestPairingCode(cleanNumber);
                console.log("\n==================================================");
                console.log(`📱 WHATSAPP PAIRING CODE: 👉  ${code}  👈`);
                console.log("==================================================\n");
              }
            } catch (err: any) {
              console.error("⚠️ Pairing request failed (will retry):", err?.message || err);
              pairingRequested = false;
            }
          }, 6000);
        }
      }

      if (connection === "close") {
        isConnecting = false;
        pairingRequested = false;

        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        console.log(`❌ WhatsApp Closed (Status Code: ${statusCode})`);

        // Handle 440 (Conflict / Replaced Connection) safely
        if (statusCode === 440) {
          console.warn(
            "⚠️ Connection replaced (Status 440). Stopping auto-reconnect loop. Waiting for stable state..."
          );
          cleanupSocket();
          // Delay longer before single recovery attempt to let remote session drop
          reconnectTimer = setTimeout(() => {
            connectToWhatsApp();
          }, 15000);
          return;
        }

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut && statusCode !== 401;

        if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
          console.warn("⚠️ Session invalidated or logged out. Resetting auth state...");
          clearSessionFolder();
          reconnectTimer = setTimeout(() => connectToWhatsApp(), 3000);
        } else if (shouldReconnect) {
          console.log("🔄 Reconnecting in 5 seconds...");
          reconnectTimer = setTimeout(() => connectToWhatsApp(), 5000);
        }
      } else if (connection === "open") {
        isConnecting = false;
        pairingRequested = false;
        console.log("\n==================================================");
        console.log("✅ WhatsApp Microservice Connected & Ready!");
        console.log("==================================================\n");
      }
    });
  } catch (err) {
    isConnecting = false;
    pairingRequested = false;
    console.error("Failed to connect WhatsApp:", err);
  }
};

// Ping Endpoint
app.get("/ping", (req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    socketConnected: !!sock && sock?.ws?.isOpen,
  });
});

// Send WhatsApp Message API
app.post("/send-message", async (req: Request, res: Response) => {
  const authHeader = req.headers["x-secret-key"];
  if (authHeader !== SECRET_KEY) {
    return res.status(403).json({ success: false, message: "Unauthorized access!" });
  }

  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ success: false, message: "Phone and message required!" });
  }

  try {
    if (!sock) {
      return res
        .status(503)
        .json({ success: false, message: "WhatsApp socket not connected yet!" });
    }

    let rawNumber = phone.replace(/@s\.whatsapp\.net$/i, "").trim();
    let formattedPhone = rawNumber.replace(/\D/g, "");
    if (formattedPhone.startsWith("0")) {
      formattedPhone = `88${formattedPhone}`;
    }

    const jid = `${formattedPhone}@s.whatsapp.net`;

    const result = await sock.sendMessage(jid, { text: message });
    console.log(`✅ [WhatsApp Dispatch Success] To: ${formattedPhone} | Msg ID: ${result?.key?.id}`);

    return res.status(200).json({
      success: true,
      message: "WhatsApp message dispatched successfully!",
      messageId: result?.key?.id,
    });
  } catch (err: any) {
    console.error("❌ [WhatsApp Dispatch Failed]:", err?.message || err);
    return res.status(500).json({ success: false, message: "Failed to dispatch WhatsApp message" });
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Microservice running on port ${PORT}`);
  connectToWhatsApp();
});

// Graceful Process Shutdown Handler
const handleGracefulShutdown = (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  cleanupSocket();
  server.close(() => {
    console.log("👋 HTTP server closed. Exiting process.");
    process.exit(0);
  });
};

process.on("SIGTERM", () => handleGracefulShutdown("SIGTERM"));
process.on("SIGINT", () => handleGracefulShutdown("SIGINT"));