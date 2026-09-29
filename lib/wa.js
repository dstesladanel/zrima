'use strict';
// WhatsApp transport. Default "log" mode records the message only.
// Set WHATSAPP_TOKEN + WHATSAPP_PHONE_ID to send through the WhatsApp Cloud API.
// Note: business-initiated messages outside the 24h window need approved templates in production.
async function send(to, text) {
  const token = process.env.WHATSAPP_TOKEN, pid = process.env.WHATSAPP_PHONE_ID;
  if (!token || !pid) return { ok: true, mode: 'log' };
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
