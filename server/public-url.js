function cleanPublicUrl(value, fallback = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}

module.exports = {
  cleanPublicUrl,
};
