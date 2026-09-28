import { defineHostExtension } from "../../../internal/host-extensions.js";
import { SAND_AUTO_REVIEW_HOST_GENERATION } from "../../runner/sand-auto-review.js";
import { HostExtensions } from "../extension-ids.generated.js";
import {
  AutoReviewService,
  parseLocalAutoReviewMode,
  type AutoReviewServiceDeps,
} from "./auto-review-service.js";
import { createSandBackendSmartModeClassifierExecutor } from "./sand-backend-smart-mode-classifier-exec.js";
import { createLocalProviderSmartModeClassifierExecutor } from "./local-provider-classifier.js";
import { isLocalAdminEnabled } from "../../../shared/node/local-admin.js";
import type { TextOnlyInferenceOwner } from "../inference/text-only-completion.js";

type AutoReviewAuth = Parameters<typeof createSandBackendSmartModeClassifierExecutor>[0];
type AutoReviewClassifier = ReturnType<typeof createSandBackendSmartModeClassifierExecutor>;
type AutoReviewDependencies = Omit<
  AutoReviewServiceDeps<AutoReviewClassifier, AutoReviewAuth>,
  "hostGeneration" | "localMode" | "now" | "createClassifierExecutor"
> & {
  readonly transcript: AutoReviewServiceDeps<AutoReviewClassifier, AutoReviewAuth>["transcript"] & {
    createAwaitingStateSink(): AutoReviewServiceDeps<AutoReviewClassifier, AutoReviewAuth>["awaitingSink"];
    listAgentIds(): Promise<readonly string[]>;
    expireAllPendingAutoReviewApprovalCards(): Promise<unknown>;
  };
};

export const autoReviewExtension = defineHostExtension<
  AutoReviewService<AutoReviewClassifier, AutoReviewAuth>
>({
  id: HostExtensions.AutoReview,
  dependencies: [
    HostExtensions.Auth,
    HostExtensions.Experiments,
    HostExtensions.Settings,
    HostExtensions.Telemetry,
    HostExtensions.Transcript,
    HostExtensions.Inference,
  ],
  start: (context) => {
    const auth = context.deps[HostExtensions.Auth] as AutoReviewAuth;
    const experiments = context.deps[HostExtensions.Experiments] as AutoReviewDependencies["experiments"];
    const settings = context.deps[HostExtensions.Settings] as AutoReviewDependencies["settings"];
    const telemetry = (context.deps[HostExtensions.Telemetry] as {
      logs: AutoReviewDependencies["telemetry"];
    }).logs;
    const transcript = context.deps[HostExtensions.Transcript] as AutoReviewDependencies["transcript"];
    const service = new AutoReviewService({
      auth,
      experiments,
      settings,
      telemetry,
      awaitingSink: transcript.createAwaitingStateSink(),
      transcript,
      hostGeneration: SAND_AUTO_REVIEW_HOST_GENERATION,
      localMode: isLocalAdminEnabled() ? "enforce" : parseLocalAutoReviewMode(process.env.SAND_AUTO_REVIEW_MODE)!,
      createClassifierExecutor: isLocalAdminEnabled()
        ? () => createLocalProviderSmartModeClassifierExecutor((context.deps[HostExtensions.Inference] as { readonly port: TextOnlyInferenceOwner }).port)
        : createSandBackendSmartModeClassifierExecutor,
    });
    context.onStop(() => service.stop());
    const startedAtMs = Date.now();
    const sweepBadges = () => service.sweepStaleAwaitingBadges(
      () => transcript.listAgentIds(),
      startedAtMs,
    );
    void transcript.expireAllPendingAutoReviewApprovalCards().then(sweepBadges, sweepBadges);
    return service;
  },
});
