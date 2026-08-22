const GROUP_OR_STATUS_RE = /(@g\.us$|^status@broadcast$)/i;
const PHONE_JID_RE = /@(c\.us|s\.whatsapp\.net)$/i;
const LID_JID_RE = /@lid$/i;

function isGroupOrStatusJid(value) {
    const raw = String(value || '').trim().toLowerCase();
    return GROUP_OR_STATUS_RE.test(raw);
}

function normalizeKazakhstanPhone(digits) {
    if (!digits) return '';

    let phone = String(digits).replace(/\D/g, '');
    if (phone.startsWith('00')) phone = phone.slice(2);
    if (phone.length === 10) phone = `7${phone}`;
    if (phone.startsWith('8') && phone.length === 11) phone = `7${phone.slice(1)}`;

    return /^7\d{10}$/.test(phone) ? phone : '';
}

function extractPhoneCandidate(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw || isGroupOrStatusJid(raw)) return '';

    if (LID_JID_RE.test(raw)) {
        const match = raw.match(/^(\d+)/);
        if (match) return `${match[1]}@lid`;
        return '';
    }

    const phoneLikeMatch =
        raw.match(/(?:\+?7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s().-]*\d{2}[\s().-]*\d{2}/) ||
        raw.match(/\d{10,15}/);
    if (phoneLikeMatch) return phoneLikeMatch[0];

    // An international number written with separators matches neither pattern
    // above: the first only accepts a Kazakhstan 7/8 prefix, and the second needs
    // 10 contiguous digits. A WhatsApp JID is contiguous so it takes the fast path,
    // but a contact record can carry "+90 532 123 45 67" - and returning '' here
    // meant whatsappManager dropped the whole message before the WAL (2026-08-22).
    // The leading + is required on purpose: it keeps a group JID, which never has
    // one, out of this branch.
    const separated = raw.match(/\+\d[\d\s().-]{8,20}\d/);
    if (separated) {
        const digits = separated[0].replace(/\D/g, '');
        if (digits.length >= 10 && digits.length <= 15) return digits;
    }

    return '';
}

// A Kazakhstan number is normalised to its canonical 7XXXXXXXXXX form so every
// Redis key for the same customer agrees. Any OTHER international number keeps its
// digits instead of being thrown away.
//
// WHY: normalizeKazakhstanPhone returns '' for anything that is not ^7\d{10}$, and
// whatsappManager.js drops the inbound message when isValidChatPhone fails - before
// the WAL, before the store, before Openbot, with no log line. A customer writing
// from +998, +90 or +49 simply vanished: no inbox entry, no bot reply, no trace
// (found 2026-08-22). isValidChatPhone already accepts 10-15 digits, so the only
// thing standing in the way was this silent '' .
function normalizePhone(value) {
    const candidate = extractPhoneCandidate(value);
    if (String(candidate).endsWith('@lid')) return candidate;
    const kazakhstan = normalizeKazakhstanPhone(candidate);
    if (kazakhstan) return kazakhstan;
    const digits = String(candidate).replace(/\D/g, '');
    return /^\d{10,15}$/.test(digits) ? digits : '';
}

function isValidChatPhone(phone) {
    return /^(\d{10,15}|\d+@lid)$/.test(String(phone || ''));
}

function normalizePhoneFromCandidates(candidates = []) {
    for (const candidate of candidates) {
        const phone = normalizePhone(candidate);
        if (phone) return phone;
    }

    return '';
}

function getPhoneCandidatesFromWebhook(data = {}, eventData = {}, key = {}) {
    return [
        eventData.normalizedPhone,
        data.normalizedPhone,
        eventData.senderPhone,
        data.senderPhone,
        eventData.phone,
        data.phone,
        typeof eventData.sender === 'string' ? eventData.sender : '',
        typeof data.sender === 'string' ? data.sender : '',
        key.participant,
        key.remoteJid,
        key.id?.remote
    ];
}

function toWhatsAppChatId(value, jidLookup = null) {
    const raw = String(value || '').trim();
    if (!raw || isGroupOrStatusJid(raw)) return '';

    const phone = normalizePhone(raw);
    if (phone && jidLookup && jidLookup.has(phone)) return jidLookup.get(phone);
    if (PHONE_JID_RE.test(raw) || LID_JID_RE.test(raw)) return raw;
    if (phone) return `${phone}@c.us`;

    return '';
}

module.exports = {
    isGroupOrStatusJid,
    isValidChatPhone,
    normalizePhone,
    normalizePhoneFromCandidates,
    getPhoneCandidatesFromWebhook,
    toWhatsAppChatId
};
