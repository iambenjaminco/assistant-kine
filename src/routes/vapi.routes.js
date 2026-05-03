// src/routes/vapi.routes.js
const express = require("express");
const { executeTool } = require("../services/voice/tools");
const { findCabinetByTwilioNumber } = require("../services/cabinetsStore");

const router = express.Router();

// Vérification du secret partagé Vapi → ton serveur
function verifyVapiSecret(req, res, next) {
  const secret = req.headers["x-vapi-secret"];
  if (!secret || secret !== process.env.VAPI_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Webhook unique appelé par Vapi pour tous les events
router.post("/vapi/webhook", verifyVapiSecret, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.json({});

    // 1. Quand un appel arrive : Vapi nous demande la config de l'assistant
    if (message.type === "assistant-request") {
      return handleAssistantRequest(message, res);
    }

    // 2. Quand le LLM appelle un tool
    if (message.type === "tool-calls") {
      return handleToolCalls(message, res);
    }

    // 3. Fin d'appel : log
    if (message.type === "end-of-call-report") {
      console.log("[VAPI][END_OF_CALL]", {
        callId: message.call?.id,
        durationSeconds: message.durationSeconds,
        cost: message.cost,
        endedReason: message.endedReason,
      });
      return res.json({});
    }

    return res.json({});
  } catch (err) {
    console.error("[VAPI][WEBHOOK_ERROR]", {
      message: err?.message,
      stack: err?.stack,
    });
    return res.status(500).json({ error: "Internal error" });
  }
});

async function handleAssistantRequest(message, res) {
  const calledNumber =
    message.call?.phoneNumber?.number ||
    message.phoneNumber?.number ||
    "";

  console.log("[VAPI][ASSISTANT_REQUEST]", { calledNumber });

  const resolved = await findCabinetByTwilioNumber(calledNumber);

  if (!resolved) {
    return res.json({
      assistant: {
        firstMessage:
          "Aucun cabinet n'est configuré pour ce numéro. Au revoir.",
        endCallAfterFirstMessage: true,
      },
    });
  }

  const { cabinetId, cabinet } = resolved;

  if (cabinet.status && cabinet.status !== "active") {
    return res.json({
      assistant: {
        firstMessage:
          "Le service de prise de rendez-vous automatique est momentanément indisponible. Merci de contacter directement le cabinet.",
        endCallAfterFirstMessage: true,
      },
    });
  }

  const practitionersList = buildPractitionersList(cabinet);

  return res.json({
    assistantId: cabinet.vapiAssistantId,
    assistantOverrides: {
      variableValues: {
        cabinetId,
        assistantName: cabinet.assistantName || "Marie",
        cabinetDisplayName: cabinet.displayName || cabinet.name,
        appointmentLabel: cabinet.appointmentLabel || "santé",
        practitionersList,
      },
    },
  });
}

function buildPractitionersList(cabinet) {
  const names = (cabinet.practitioners || []).map((p) => p.name);
  if (!names.length) return "Le cabinet compte plusieurs praticiens.";
  if (names.length === 1) return `Le cabinet compte 1 praticien : ${names[0]}.`;
  const last = names.pop();
  return `Le cabinet compte ${names.length + 1} praticiens : ${names.join(", ")} et ${last}.`;
}

async function handleToolCalls(message, res) {
  const cabinetId =
    message.call?.assistantOverrides?.variableValues?.cabinetId;
  const callSid = message.call?.id;
  const customerPhone = message.call?.customer?.number || "";

  const context = { cabinetId, callSid, customerPhone };

  const toolCalls = message.toolCalls || message.toolCallList || [];

  console.log("[VAPI][TOOL_CALLS]", {
    callSid,
    cabinetId,
    count: toolCalls.length,
    names: toolCalls.map((tc) => tc.function?.name),
  });

  const results = await Promise.all(
    toolCalls.map(async (tc) => {
      let params = {};
      try {
        params =
          typeof tc.function?.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function?.arguments || {};
      } catch (_err) {
        params = {};
      }

      const result = await executeTool(tc.function?.name, params, context);
      return {
        toolCallId: tc.id,
        result,
      };
    })
  );

  return res.json({ results });
}

module.exports = router;