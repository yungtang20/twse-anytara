export interface StockData {
  id: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  prevPrice: number;
  prevChange: number;
  prevChangePercent: number;
  volume: number;
  volDiff: number;
  prevVolume: number;
  prevVolDiff: number;
  lastDate: string;
  histDate: string;
  
  shortPressure: number;
  midPressure: number;
  longPressure: number;
  shortSupport: number;
  midSupport: number;
  longSupport: number;
  
  integratedSupports: { price: number; power: number }[];
  integratedPressures: { price: number; power: number }[];
  accelerateRiseStart?: number;
  accelerateRiseEnd?: number;
  accelerateRiseCenter?: number;
  volDenseStart?: number;
  volDenseEnd?: number;
  structureHigh?: number;
  structureLow?: number;
  
  ma25: number;
  ma60: number;
  ma200: number;
  ma25Trend: string;
  ma60Trend: string;
  ma200Trend: string;
  maGapPercent: number;
  maArrangement: string;
  maInterpretation: string;
  ma60Deduction: number;
  ma200Deduction: number;
  
  foreignConsecutiveDays: number;
  trustConsecutiveDays: number;
  chipHistory: { date: string; foreign: number; trust: number }[];
  
  aiStatus: string;
  aiStrength: string;
  aiScore: number;
  aiOffset: string;
  aiReason: string;
  predictions: { day: string; price: number; pct: number }[];
  
  patternName: string;
  patternIsUp: boolean;
  patternNeckline: number;
  patternTarget: number;
  patternStopLoss: number;
  
  source_type?: string;
}
