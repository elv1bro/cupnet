import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ca = require('../../mini/ca.js');

describe('ca helpers', () => {
    it('exports the install/status API', () => {
        expect(typeof ca.caTrustStatus).toBe('function');
        expect(typeof ca.installCa).toBe('function');
        expect(ca.CA_COMMON_NAME).toBe('CupNet MITM CA');
    });

    it('reports an unreadable CA cert without touching the OS store', () => {
        // No cert → fails before running any `security`/`certutil` command, so this stays hermetic.
        const st = ca.caTrustStatus('/no/such/cupnet-ca.pem', 'darwin');
        expect(st).toMatchObject({ platform: 'darwin', installed: false, trusted: false });
        expect(st.error).toBeTruthy();
    });

    it('still computes the SPKI pin and manual commands for the UI', () => {
        const cmds = ca.caInstructions('/tmp/ca.pem', 'darwin');
        expect(cmds.install).toContain('add-trusted-cert');
        expect(cmds.verify).toContain('find-certificate');
    });
});
