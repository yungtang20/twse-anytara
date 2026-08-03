import type {
  AIResearchPacket,
  RenderedResearchClaim,
} from "../../shared/aiResearch";
import { validateResearchFindingRuntime } from "./aiResearchFindingPolicy";

export function renderResearchFinding(
  finding: unknown,
  packet: AIResearchPacket,
): RenderedResearchClaim {
  return validateResearchFindingRuntime(finding, packet).renderedClaim;
}
