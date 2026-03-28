import { env } from "../config/env.js";

export interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan?: unknown[];
}

export interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
}

export class JupiterClient {
  private readonly baseUrl = "https://lite-api.jup.ag/swap/v1";

  async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
  }): Promise<JupiterQuoteResponse> {
    const url = new URL(`${this.baseUrl}/quote`);
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amount);
    url.searchParams.set("slippageBps", String(params.slippageBps));
    url.searchParams.set("restrictIntermediateTokens", "true");

    console.log("Fetching:", url.toString());

    try {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) {
        const body = await response.text();
        console.error("Jupiter quote non-OK response:", {
          url: url.toString(),
          status: response.status,
          statusText: response.statusText,
          body,
        });
        throw new Error(`Jupiter quote failed with status ${response.status}`);
      }

      return response.json() as Promise<JupiterQuoteResponse>;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Jupiter quote fetch failed:", {
        url: url.toString(),
        message,
        error,
      });
      throw error;
    }
  }

  async buildSwap(params: {
    quoteResponse: JupiterQuoteResponse;
    userPublicKey: string;
    priorityFeeLamports?: number;
  }): Promise<JupiterSwapResponse> {
    const url = `${this.baseUrl}/swap`;
    console.log("Fetching:", url);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          quoteResponse: params.quoteResponse,
          userPublicKey: params.userPublicKey,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: params.priorityFeeLamports,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error("Jupiter swap non-OK response:", {
          url,
          status: response.status,
          statusText: response.statusText,
          body,
        });
        throw new Error(`Jupiter swap build failed with status ${response.status}`);
      }

      return response.json() as Promise<JupiterSwapResponse>;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Jupiter swap fetch failed:", {
        url,
        message,
        error,
      });
      throw error;
    }
  }
}
