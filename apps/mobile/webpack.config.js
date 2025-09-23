const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('@expo/webpack-config');
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');

module.exports = async (env = {}, argv = {}) => {
  const config = await getDefaultConfig({ projectRoot: __dirname, ...env }, argv);

  const shouldAnalyze = env?.analyze === 'true' || process.env.ANALYZE_BUNDLE === 'true';

  if (shouldAnalyze) {
    const reportsDir = path.resolve(__dirname, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });

    config.plugins = config.plugins || [];
    config.plugins.push(
      new BundleAnalyzerPlugin({
        analyzerMode: 'static',
        openAnalyzer: false,
        generateStatsFile: true,
        reportFilename: path.join(reportsDir, 'bundle-report.html'),
        statsFilename: path.join(reportsDir, 'bundle-stats.json'),
      }),
    );
  }

  return config;
};
