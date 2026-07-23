const fs = require('fs');
const content = fs.readFileSync('src/components/views/MarketsView.tsx', 'utf-8');
const lines = content.split('\n');
const start = lines.findIndex(l => l.includes('FIVE COGNITIVE TERMINAL ANALYSIS PANELS'));
const end = lines.findIndex(l => l.includes('Footer command bar'));

if (start !== -1 && end !== -1) {
  const replacement = `        {/* REPLACED WITH REAL PANELS */}
        <div className="p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-2 gap-6 bg-slate-900 text-slate-300">
          <div className="space-y-6">
            <SRPanel stockId={stock.id} />
            <MAPanel stockId={stock.id} change={stock.change ?? 0} changePercent={stock.changePercent ?? 0} />
            <PatternPanel stockId={stock.id} />
          </div>
          <div className="space-y-6">
            <ChipsPanel stockId={stock.id} />
            <PredictionPanel stockId={stock.id} />
          </div>
        </div>
`;
  lines.splice(start, end - start, replacement);
  fs.writeFileSync('src/components/views/MarketsView.tsx', lines.join('\n'));
} else {
  console.log('Not found');
}
