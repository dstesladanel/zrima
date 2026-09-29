'use strict';
// WhatsApp transport. Default "manual" mode (free): the message waits in the owner's outbox and is sent with one tap via wa.me.
// Set WHATSAPP_TOKEN + WHATSAPP_PHONE_ID to send through the WhatsApp Cloud API.
// Note: business-initiated messages outside the 24h window need approved templates in production.
async function send(to, text, creds = {}) {
  const token = creds.token, pid = creds.phoneId;
  if (!token || !pid) return { ok: true, mode: 'manual' };
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${pid}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
    });
    return { ok: r.ok, mode: 'cloud' };
  } catch { return { ok: false, mode: 'cloud' }; }
}
module.exports = { send };
