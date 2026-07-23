const { execSync } = require('child_process');
try {
  console.log('Running fast_sync.js...');
  execSync('node scripts/fast_sync.js', { stdio: 'inherit' });
  console.log('Running pull_from_supabase.js...');
  execSync('node scripts/pull_from_supabase.js', { stdio: 'inherit' });
  console.log('Running complete_and_fetch_today.js...');
  execSync('node scripts/complete_and_fetch_today.js', { stdio: 'inherit' });
} catch (e) {
  console.error(e);
}
