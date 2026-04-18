const express = require("express");
const { google } = require("googleapis");

const {
  buildGoogleAuthUrl,
  exchangeGoogleCodeForTokens,
  buildOAuthClientFromTokens,
} = require("../config/googleOAuth");

const {
  upsertPractitionerGoogleConnection,
  setPractitionerSelectedCalendarId,
  getPractitionerGoogleConnection,
} = require("../services/practitionerGoogleConnectionsStore");

const router = express.Router();

function encodeState(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeState(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

// 1) démarrer OAuth pour un praticien
router.get("/start", async (req, res) => {
  try {
    const { cabinetId, practitionerKey, practitionerName } = req.query;

    if (!cabinetId || !practitionerKey) {
      return res.status(400).json({ error: "cabinetId et practitionerKey requis" });
    }

    const state = encodeState({
      cabinetId,
      practitionerKey,
      practitionerName: practitionerName || "",
    });

    const url = buildGoogleAuthUrl({ state });
    return res.redirect(url);
  } catch (err) {
    console.error("[GOOGLE_OAUTH][START_ERROR]", err);
    return res.status(500).json({ error: "GOOGLE_OAUTH_START_FAILED" });
  }
});

// 2) callback OAuth
router.get("/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.status(400).send("Paramètres OAuth manquants");
    }

    const decoded = decodeState(state);
    const { cabinetId, practitionerKey, practitionerName } = decoded;

    const tokens = await exchangeGoogleCodeForTokens(code);
    const oauth2Client = buildOAuthClientFromTokens(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const me = await oauth2.userinfo.get();

    await upsertPractitionerGoogleConnection({
      practitionerKey,
      cabinetId,
      practitionerName,
      googleEmail: me.data.email || null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scope: tokens.scope,
      tokenType: tokens.token_type,
      expiryDate: tokens.expiry_date,
      selectedCalendarId: null,
    });

    return res.send("Google Calendar connecté. Vous pouvez revenir à l’onboarding.");
  } catch (err) {
    console.error("[GOOGLE_OAUTH][CALLBACK_ERROR]", err);
    return res.status(500).send("Connexion Google impossible");
  }
});

// 3) lister les calendriers accessibles du praticien
router.get("/practitioner/:practitionerKey/calendars", async (req, res) => {
  try {
    const { practitionerKey } = req.params;
    const connection = await getPractitionerGoogleConnection(practitionerKey);

    if (!connection) {
      return res.status(404).json({ error: "PRACTITIONER_GOOGLE_CONNECTION_NOT_FOUND" });
    }

    const oauth2Client = buildOAuthClientFromTokens({
      access_token: connection.access_token,
      refresh_token: connection.refresh_token,
      scope: connection.scope,
      token_type: connection.token_type,
      expiry_date: connection.expiry_date,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const result = await calendar.calendarList.list();

    const calendars = (result.data.items || []).map((item) => ({
      id: item.id,
      summary: item.summary,
      primary: Boolean(item.primary),
      accessRole: item.accessRole || null,
    }));

    return res.json({ calendars });
  } catch (err) {
    console.error("[GOOGLE_OAUTH][LIST_CALENDARS_ERROR]", err);
    return res.status(500).json({ error: "LIST_PRACTITIONER_CALENDARS_FAILED" });
  }
});

// 4) choisir le calendrier final du praticien
router.post("/practitioner/:practitionerKey/select-calendar", express.json(), async (req, res) => {
  try {
    const { practitionerKey } = req.params;
    const { calendarId } = req.body || {};

    if (!calendarId) {
      return res.status(400).json({ error: "calendarId requis" });
    }

    const updated = await setPractitionerSelectedCalendarId(practitionerKey, calendarId);
    return res.json({ ok: true, connection: updated });
  } catch (err) {
    console.error("[GOOGLE_OAUTH][SELECT_CALENDAR_ERROR]", err);
    return res.status(500).json({ error: "SELECT_PRACTITIONER_CALENDAR_FAILED" });
  }
});

module.exports = router;