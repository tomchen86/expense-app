module.exports = {
  presets: ['module:metro-react-native-babel-preset'],
  plugins: [['@babel/plugin-transform-private-methods', { loose: true }]],
  env: {
    test: {
      presets: ['module:metro-react-native-babel-preset'],
      plugins: [['@babel/plugin-transform-private-methods', { loose: true }]],
    },
  },
};
