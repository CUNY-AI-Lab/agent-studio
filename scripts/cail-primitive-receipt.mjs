// This is an application-owned receipt for the CAIL package boundaries that
// Agent Studio imports. It is intentionally narrower than a package-manager
// lock graph: Bun's frozen install remains authoritative for peer/transitive
// dependency selection and package bytes.
export const CAIL_PRIMITIVE_RECEIPTS = Object.freeze([
  {
    name: '@cuny-ai-lab/cail-identity',
    version: '5.1.2',
    source: 'https://npm.pkg.github.com/download/@cuny-ai-lab/cail-identity/5.1.2/457eb418b1ea36b26bd9e6dd1650cfb8cb264878',
    integrity: 'sha512-FQej5lWjeOfZreEObYd92NzNEe5DxHFCCn6qWXIxqDRAfUoEtYJmZn8ittJlzs7y4BGFwNZjTaBX/qn6wHAQuQ==',
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
    version: '3.0.1',
    source: 'https://npm.pkg.github.com/download/@cuny-ai-lab/cail-client/3.0.1/08719b1978a95c1bb9b5b19c5773dbbe6bfbffbd',
    integrity: 'sha512-fS8p50xk5aU+omY7+wVEQD+GNHIQBHwvilliJSe43m8Wxc7HeMbMxVhokNVE3Sfn3r+RvhewXaZ0e5SHoR24CQ==',
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
