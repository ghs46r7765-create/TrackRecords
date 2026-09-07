/* Garmin-Connect-Proxy für Laufvergleich.
 *
 * Läuft server-seitig (Vercel Serverless Function), weil Garmin Connect keine
 * Cross-Origin-Requests aus dem Browser erlaubt. Diese Funktion hält keinerlei
 * Zustand zwischen Aufrufen: Zugangsdaten werden nur für den einmaligen Login
 * verwendet und nirgends gespeichert; Sitzungs-Token (oauth1/oauth2) werden
 * bei jedem Request vom Client mitgeschickt und ggf. aktualisiert zurückgegeben
 * (der Client persistiert sie lokal in IndexedDB).
 *
 * Basiert auf dem npm-Paket "garmin-connect" (inoffizieller, reverse-engineerter
 * Client für den SSO/OAuth-Login-Flow der Garmin-Connect-Mobile-App). Kein MFA-
 * Support — falls Garmin künftig MFA erzwingt oder den Login-Flow ändert, schlägt
 * der Login hier fehl.
 */
const { GarminConnect } = require("garmin-connect");

function newClient(){
  // Platzhalter-Credentials: nur der Konstruktor verlangt sie, für
  // list/gpx wird ausschließlich loadToken() genutzt, nie login().
  return new GarminConnect({ username: "_", password: "_" });
}

module.exports = async (req, res) => {
  if(req.method !== "POST"){
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let body = req.body;
  if(typeof body === "string"){
    try{ body = JSON.parse(body); } catch(e){ res.status(400).json({ error: "Ungültiger Request-Body" }); return; }
  }
  body = body || {};
  const { action } = body;

  try{
    if(action === "login"){
      const { username, password } = body;
      if(!username || !password){
        res.status(400).json({ error: "Benutzername und Passwort erforderlich" });
        return;
      }
      const gc = new GarminConnect({ username, password });
      await gc.login();
      const tokens = gc.exportToken();
      res.status(200).json({ oauth1: tokens.oauth1, oauth2: tokens.oauth2 });
      return;
    }

    if(action === "list"){
      const { oauth1, oauth2, start, limit, startDate, endDate } = body;
      if(!oauth1 || !oauth2){
        res.status(401).json({ error: "Keine gültige Sitzung — bitte erneut anmelden." });
        return;
      }
      const gc = newClient();
      gc.loadToken(oauth1, oauth2);
      const activities = await gc.get(gc.url.ACTIVITIES, {
        params: {
          start: start || 0,
          limit: limit || 100,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
        },
      });
      res.status(200).json({
        activities: Array.isArray(activities) ? activities : [],
        oauth1: gc.client.oauth1Token,
        oauth2: gc.client.oauth2Token,
      });
      return;
    }

    if(action === "gpx"){
      const { oauth1, oauth2, activityIds } = body;
      if(!oauth1 || !oauth2){
        res.status(401).json({ error: "Keine gültige Sitzung — bitte erneut anmelden." });
        return;
      }
      if(!Array.isArray(activityIds) || activityIds.length === 0){
        res.status(400).json({ error: "Keine Aktivitäts-IDs übergeben" });
        return;
      }
      if(activityIds.length > 20){
        res.status(400).json({ error: "Zu viele IDs auf einmal angefragt (max. 20 pro Aufruf)" });
        return;
      }
      const gc = newClient();
      gc.loadToken(oauth1, oauth2);
      const files = [];
      for(const activityId of activityIds){
        try{
          const data = await gc.get(gc.url.DOWNLOAD_GPX + activityId);
          const text = typeof data === "string" ? data : "";
          if(text && text.trim().startsWith("<")){
            files.push({ activityId, gpx: text });
          } else {
            files.push({ activityId, error: "Keine GPX-Daten (evtl. keine GPS-Route, z.B. Krafttraining)" });
          }
        } catch(e){
          files.push({ activityId, error: e && e.message ? e.message : String(e) });
        }
        // Kleine Pause zwischen einzelnen Downloads, um Garmin nicht mit
        // Bursts zu belasten — schont API-Rate-Limits (unabhängig vom Login-Limit).
        await new Promise(r => setTimeout(r, 150));
      }
      res.status(200).json({
        files,
        oauth1: gc.client.oauth1Token,
        oauth2: gc.client.oauth2Token,
      });
      return;
    }

    if(action === "gpxzip"){
      const { oauth1, oauth2, activityIds } = body;
      if(!oauth1 || !oauth2){
        res.status(401).json({ error: "Keine gültige Sitzung — bitte erneut anmelden." });
        return;
      }
      if(!Array.isArray(activityIds) || activityIds.length === 0){
        res.status(400).json({ error: "Keine Aktivitäts-IDs übergeben" });
        return;
      }
      if(activityIds.length > 20){
        res.status(400).json({ error: "Zu viele IDs auf einmal angefragt (max. 20 pro Aufruf)" });
        return;
      }
      const JSZip = require("jszip");
      const gc = newClient();
      gc.loadToken(oauth1, oauth2);
      const zip = new JSZip();
      const included = [];
      const failed = [];
      for(const activityId of activityIds){
        try{
          const data = await gc.get(gc.url.DOWNLOAD_GPX + activityId);
          const text = typeof data === "string" ? data : "";
          if(text && text.trim().startsWith("<")){
            zip.file(`${activityId}.gpx`, text);
            included.push(activityId);
          } else {
            failed.push({ id: activityId, error: "Keine GPX-Daten (evtl. keine GPS-Route, z.B. Krafttraining)" });
          }
        } catch(e){
          failed.push({ id: activityId, error: e && e.message ? e.message : String(e) });
        }
        await new Promise(r => setTimeout(r, 150));
      }
      let zipBase64 = null;
      if(included.length > 0){
        const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
        zipBase64 = buf.toString("base64");
      }
      res.status(200).json({
        zipBase64, included, failed,
        oauth1: gc.client.oauth1Token,
        oauth2: gc.client.oauth2Token,
      });
      return;
    }

    res.status(400).json({ error: "Unbekannte Aktion: " + action });
  } catch(err){
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
};
