module.exports = function (api) {
  api.cache(true);

  const privateFeaturePlugins = [
    ["@babel/plugin-transform-private-methods", { loose: true }],
    ["@babel/plugin-transform-private-property-in-object", { loose: true }],
  ];

  return {
    presets: ["babel-preset-expo"],
    plugins: privateFeaturePlugins,
    env: {
      test: {
        presets: ["babel-preset-expo"],
        plugins: privateFeaturePlugins,
      },
    },
  };
};
