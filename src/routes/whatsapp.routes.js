import { Router } from "express";

const router = Router();

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// Verify webhook
router.get("/", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("WhatsApp webhook verified");
        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
});

// Receive webhook events
router.post("/", (req, res) => {
    console.log(
        "Incoming WhatsApp webhook:",
        JSON.stringify(req.body, null, 2)
    );

    // TODO:
    // Save message
    // Trigger AI
    // Send reply

    return res.sendStatus(200);
});

export default router;