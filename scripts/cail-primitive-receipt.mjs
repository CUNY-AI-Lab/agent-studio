// This is an application-owned receipt for the CAIL package boundaries that
// Agent Studio imports. It is intentionally narrower than a package-manager
// lock graph: Bun's frozen install remains authoritative for peer/transitive
// dependency selection and package bytes.
export const CAIL_PRIMITIVE_RECEIPTS = Object.freeze([
  {
    name: '@cuny-ai-lab/cail-identity',
    version: '5.1.0',
    source: 'https://npm.pkg.github.com/download/@cuny-ai-lab/cail-identity/5.1.0/27675a38c797795d11c3e99b8f7d2e519731faf2',
    integrity: 'sha512-L4XnjVlefEctstO7OKCPnQV0yv/WQyIuowx6aBe1Tq603iANuDCTp16n5llwmVEOC2tRh1CDnRQuD06kJZASFQ==',
    exports: [
      '.',
      './testing',
      './contract/principal-v1.json',
      './contract/identity-jwt-claims-v1.json',
      './contract/subject-derivation-v2.json',
      './contract/subject-derivation-v2.lua',
    ],
    entrypoints: ['@cuny-ai-lab/cail-identity', '@cuny-ai-lab/cail-identity/testing'],
  },
  {
    name: '@cuny-ai-lab/cail-client',
    version: '3.0.0',
    source: 'https://npm.pkg.github.com/download/@cuny-ai-lab/cail-client/3.0.0/8bd43f0ee8e218a40c34b21a116112a727901b5d',
    integrity: 'sha512-HnKVCH+6PQedqD6WryxXMEi5mGzSqOo/wkOVFo9FMjGNaPqLLXMf5njcIJLjdA1pbKiASIM886wjep16f7lV5w==',
    exports: ['.', './testing', './contract/model-gateway-v1.json'],
    entrypoints: ['@cuny-ai-lab/cail-client', '@cuny-ai-lab/cail-client/testing'],
  },
  {
    name: '@cuny-ai-lab/cail-log',
    version: '0.6.0',
    source: 'https://npm.pkg.github.com/download/@cuny-ai-lab/cail-log/0.6.0/632c8a3d74bc4709c23b9636b73471c1291d7679',
    integrity: 'sha512-Hlj1K7TXL2XOI6nOkh5SKRafCldr87Zp+aHm73MqiV0hajAPMiqp7QuBlndzok7Vy0fIX7C6msi093s/a9Yesw==',
    exports: ['.', './contract/operational-event-v2.json'],
    entrypoints: ['@cuny-ai-lab/cail-log'],
  },
]);

export const CAIL_PRIMITIVE_NAMES = new Set(CAIL_PRIMITIVE_RECEIPTS.map(({ name }) => name));
