// BIP32 master key fingerprint (8 hex): names a wallet without revealing it.
import { mnemonicToSeed } from "npm:@scure/bip39@1.6.0";
import { HDKey } from "npm:@scure/bip32@1.7.0";

export async function seedFingerprint(mnemonic: string): Promise<string> {
  const seed = await mnemonicToSeed(mnemonic);
  const fp = HDKey.fromMasterSeed(seed).fingerprint >>> 0;
  seed.fill(0);
  return fp.toString(16).padStart(8, "0");
}
