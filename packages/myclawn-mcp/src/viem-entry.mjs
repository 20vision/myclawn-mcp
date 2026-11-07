// Build input only (see scripts/build.mjs). Everything the wallet needs from viem, nothing else.
export { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
export { createPublicClient, createWalletClient, http, parseAbi, recoverTypedDataAddress, decodeEventLog, parseSignature, encodeFunctionData } from 'viem';
export { base, baseSepolia } from 'viem/chains';
