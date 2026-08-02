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
    version: '1.3.0',
    source: 'https://npm.pkg.github.com/download/@cuny-ai-lab/cail-client/1.3.0/51b55d77eeff1d847009623ffe5af169d7bc488d',
    integrity: 'sha512-UDXBOdgRaGcnqM8T9w8yi0vkc9JT/4MzvHMAVlROYgH2zf5QP5LKvciUj1enijNdQDPASngkE/iCU+cRT332KQ==',
    exports: ['.', './testing'],
    entrypoints: ['@cuny-ai-lab/cail-client', '@cuny-ai-lab/cail-client/testing'],
  },
  {
    name: '@cuny-ai-lab/cail-log',
    version: '0.4.0',
    source: 'https://npm.pkg.github.com/download/@cuny-ai-lab/cail-log/0.4.0/67018d294dc7048944cbfab0361e46e148adaab4',
    integrity: 'sha512-V2WswlIra6BedHaf1T14JoL3RkTYkikJIusio5em9/E3PGVOdCDTKwzlszKOQ9o6t0qDhn2xs/kpqNcQIsBO4Q==',
    exports: ['.'],
    entrypoints: ['@cuny-ai-lab/cail-log'],
  },
]);

export const CAIL_PRIMITIVE_NAMES = new Set(CAIL_PRIMITIVE_RECEIPTS.map(({ name }) => name));
