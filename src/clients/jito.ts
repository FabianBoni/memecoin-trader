import { env } from "../config/env.js";

export interface JitoBundlePayload {
  jsonrpc: "2.0";
  id: number;
  method: "sendBundle";
  params: [string[]];
}

export interface PreparedJitoSubmission {
  endpoint?: string;
  authKeyPresent: boolean;
  tipLamports?: number;
  payload: JitoBundlePayload;
  dryRun: boolean;
}

export class JitoClient {
  prepareBundle(serializedTransactionsBase64: string[]): PreparedJitoSubmission {
    const prepared: PreparedJitoSubmission = {
      authKeyPresent: Boolean(env.JITO_AUTH_KEY),
      dryRun: env.DRY_RUN,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [serializedTransactionsBase64],
      },
    };

    if (env.JITO_BLOCK_ENGINE_URL) {
      prepared.endpoint = env.JITO_BLOCK_ENGINE_URL;
    }

    if (env.JITO_BUNDLE_TIP_LAMPORTS !== undefined) {
      prepared.tipLamports = env.JITO_BUNDLE_TIP_LAMPORTS;
    }

    return prepared;
  }

  async submitBundle(serializedTransactionsBase64: string[]): Promise<PreparedJitoSubmission> {
    const prepared = this.prepareBundle(serializedTransactionsBase64);

    if (env.DRY_RUN) {
      return prepared;
    }

    throw new Error("Live Jito submission is disabled until DRY_RUN is turned off in a reviewed release.");
  }
}
