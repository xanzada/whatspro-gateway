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

    // @lid is a linked-device technical identifier, so its digits are not trusted as a phone number.
    if (LID_JID_RE.test(raw)) return '';

    const phoneLikeMatch =
        raw.match(/(?:\+?7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s().-]*\d{2}[\s().-]*\d{2}/) ||
        raw.match(/\d{10,15}/);

    return phoneLikeMatch ? phoneLikeMatch[0] : '';
}

function normalizePhone(value) {
    return normalizeKazakhstanPhone(extractPhoneCandidate(value));
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
    normalizePhone,
    normalizePhoneFromCandidates,
    getPhoneCandidatesFromWebhook,
    toWhatsAppChatId
};
