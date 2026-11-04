/** Redaction for snippets: session transcripts hold whatever the user pasted. */
const MASK = '***';

const RULES = [
    // key: value / key=value / key：value — the label survives, the value does not
    [
        /([A-Za-z0-9_.-]*(?:password|passwd|pwd|passphrase|token|secret|api[_-]?key|access[_-]?key|secret[_-]?key|ak|sk)[A-Za-z0-9_.-]*)(\s*[:=：]\s*)(\S+)/gi,
        (_match, label, separator) => `${label}${separator}${MASK}`,
    ],
    // 中文标签：密码：xxx / 账号密码 xxx
    [/((?:密码|口令|密钥|令牌|验证码|账号密码)\s*[:：=]?\s*)(\S+)/g, (_match, label) => `${label}${MASK}`],
    // bearer tokens and the usual prefixed keys
    [/(\bBearer\s+)[A-Za-z0-9._-]{16,}/g, (_match, label) => `${label}${MASK}`],
    [/(\b(?:sk-|pk-|ghp_|gho_|AKIA))[A-Za-z0-9._-]{12,}/g, (_match, label) => `${label}${MASK}`],
];

/**
 * Replace credential-shaped values. Built-in rules always run; `extra` adds
 * caller-supplied regular expressions (invalid patterns are ignored).
 */
export function redact(text, extra = []) {
    if (typeof text !== 'string' || text === '') return text;
    let out = text;
    for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
    for (const source of Array.isArray(extra) ? extra : []) {
        if (typeof source !== 'string' || source === '') continue;
        try {
            out = out.replace(new RegExp(source, 'g'), MASK);
        } catch {
            /* a bad extra pattern must not break a search */
        }
    }
    return out;
}

/** Whether a string still looks like it carries a credential (for tests). */
export function looksSecret(text) {
    return redact(text, []) !== text;
}
