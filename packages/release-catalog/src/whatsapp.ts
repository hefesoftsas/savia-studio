/** Optional WhatsApp intake contributions are absent in the public release. */
export type WhatsappIntakeContribution = {
  flowJson: string;
  pluginId: string;
  solutionId: string;
  bundleId: string;
  title: string;
};

export const whatsappIntakeContributions: readonly WhatsappIntakeContribution[] =
  [];
