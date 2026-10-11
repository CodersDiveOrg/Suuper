export type OnboardingStepKey = "profile" | "team" | "integration" | "knowledge" | "assistant";

export const ONBOARDING_STEPS: { key: OnboardingStepKey; title: string; description: string }[] = [
  { key: "profile", title: "Tell us about your business", description: "Industry, size and what you want to automate." },
  { key: "team", title: "Invite your team", description: "Bring teammates in at the role they need." },
  { key: "integration", title: "Connect an integration", description: "Link Slack, WhatsApp, Shopify and more." },
  { key: "knowledge", title: "Add a knowledge base", description: "Give your assistants something to answer from." },
  { key: "assistant", title: "Create an agent or bot", description: "Put it all together and start automating." },
];

export interface BusinessProfile {
  name: string;
  industry?: string;
  companySize?: string;
  website?: string;
  primaryGoal?: string;
}

export interface OnboardingStatus {
  steps: { key: OnboardingStepKey; done: boolean }[];
  completedCount: number;
  total: number;
  completed: boolean;
  dismissed: boolean;
  profile: BusinessProfile;
}
