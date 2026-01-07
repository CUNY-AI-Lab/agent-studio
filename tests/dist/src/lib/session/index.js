"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSession = getSession;
exports.createSignedSession = createSignedSession;
exports.getSessionCookieOptions = getSessionCookieOptions;
exports.getUserDataPath = getUserDataPath;
const headers_1 = require("next/headers");
const promises_1 = require("fs/promises");
const path_1 = require("path");
const crypto_1 = require("crypto");
const DATA_DIR = process.env.DATA_DIR || 'data';
const SESSION_SECRET = process.env.SESSION_SECRET || 'default-session-secret-change-in-production';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
if (process.env.NODE_ENV === 'production') {
    if (!process.env.SESSION_SECRET || SESSION_SECRET === 'default-session-secret-change-in-production') {
        throw new Error('SESSION_SECRET must be set in production');
    }
}
// Sign a session ID
function signSessionId(sessionId) {
    const signature = (0, crypto_1.createHmac)('sha256', SESSION_SECRET)
        .update(sessionId)
        .digest('hex');
    return `${sessionId}.${signature}`;
}
// Verify and extract session ID from signed token
function verifySessionId(signedToken) {
    if (!signedToken || typeof signedToken !== 'string')
        return null;
    const parts = signedToken.split('.');
    if (parts.length !== 2)
        return null;
    const [sessionId, signature] = parts;
    // Validate session ID format (32-char hex string from proxy.ts)
    if (!/^[a-f0-9]+$/.test(sessionId) || sessionId.length !== 32) {
        return null;
    }
    const expectedSignature = (0, crypto_1.createHmac)('sha256', SESSION_SECRET)
        .update(sessionId)
        .digest('hex');
    // Constant-time comparison
    if (signature.length !== expectedSignature.length)
        return null;
    let result = 0;
    for (let i = 0; i < signature.length; i++) {
        result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
    }
    return result === 0 ? sessionId : null;
}
async function getSession() {
    var _a;
    const cookieStore = await (0, headers_1.cookies)();
    const signedSession = (_a = cookieStore.get('agent-studio-session')) === null || _a === void 0 ? void 0 : _a.value;
    if (!signedSession) {
        throw new Error('No session found');
    }
    // Verify signature
    const sessionId = verifySessionId(signedSession);
    if (!sessionId) {
        throw new Error('Invalid session signature');
    }
    // Ensure user directory exists
    const userDir = (0, path_1.join)(process.cwd(), DATA_DIR, 'users', sessionId, 'workspaces');
    await (0, promises_1.mkdir)(userDir, { recursive: true });
    return sessionId;
}
// Create a new signed session
function createSignedSession() {
    const sessionId = (0, crypto_1.randomBytes)(16).toString('hex');
    const signedValue = signSessionId(sessionId);
    return { value: signedValue, sessionId };
}
// Get session cookie options
function getSessionCookieOptions() {
    return {
        httpOnly: true,
        secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE / 1000, // in seconds
    };
}
function getUserDataPath(sessionId) {
    // Validate session ID format to prevent path traversal (32-char hex string)
    if (!/^[a-f0-9]+$/.test(sessionId) || sessionId.length !== 32) {
        throw new Error('Invalid session ID');
    }
    return (0, path_1.join)(process.cwd(), DATA_DIR, 'users', sessionId);
}
