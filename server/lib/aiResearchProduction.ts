import { AIResearchOrchestrator } from "./aiResearchOrchestrator";
import { createAIResearchRouterModelRunner } from "./aiResearchModelRunner";
import { ResearchContextAggregator } from "./researchContext";
import { createCloudResearchContextAdapter } from "./researchContextCloudAdapter";

export interface AIResearchProductionOptions {
  clock?: () => Date;
  asOfDate?: string;
}

export function createAIResearchProduction(options: AIResearchProductionOptions = {}) {
  const clock = options.clock ?? (() => new Date());
  const contextAggregator = new ResearchContextAggregator(
    createCloudResearchContextAdapter({ clock }),
    { clock, asOfDate: options.asOfDate },
  );
  const orchestrator = new AIResearchOrchestrator(
    contextAggregator,
    createAIResearchRouterModelRunner(clock),
  );
  return { contextAggregator, orchestrator };
}
