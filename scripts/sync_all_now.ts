import { execSync } from 'child_process';
try {
  console.log('Running pull_from_supabase.js...');
  execSync('node scripts/pull_from_supabase.js', { stdio: 'inherit' });
} catch (e) {
  console.error(e);
}
