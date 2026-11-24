/** Result shape accepted by the optional public comparison renderer. */
export type QuoteBatchItem = {
  productId: string;
  flowId: string;
  label: string;
  provider: string;
  status: string;
  premium?: number;
  error?: string;
  errorCode?: string;
};

/** No product renderer is bundled with the public platform release. */
export function QuoteResults(_props: Record<string, unknown>) {
  return null;
}
