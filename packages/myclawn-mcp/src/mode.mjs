import { existsSync } from 'node:fs';

// Every MyClawn cloud computer has this file (cloud-init writes it). Wallets stay off those machines: the wallet is local only.
export const onMyClawnComputer = () => existsSync('/etc/omni-agent.env');

// The wallet is opt-in: MYCLAWN_WALLET=on or --wallet turns it on, never on a MyClawn cloud computer. Otherwise no wallet is created or read for signing, and no wallet tool or text reaches the model.
export const walletEnabled = (env = process.env, cloudComputer = onMyClawnComputer()) =>
  !cloudComputer && /^(on|1|true|yes)$/i.test(String(env.MYCLAWN_WALLET ?? '').trim());
