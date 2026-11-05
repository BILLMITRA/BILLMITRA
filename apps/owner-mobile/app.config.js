const lanPreview = process.env.EXPO_PUBLIC_LAN_PREVIEW === '1'

module.exports = ({ config }) => ({
  ...config,
  name: lanPreview ? 'BillMitra Owner Test' : config.name,
  android: {
    ...config.android,
    package: lanPreview ? 'com.billmitra.owner.test' : config.android.package,
    allowBackup: false,
  },
  plugins: lanPreview ? [...(config.plugins ?? []), './plugins/withLanCleartext'] : (config.plugins ?? []),
})
