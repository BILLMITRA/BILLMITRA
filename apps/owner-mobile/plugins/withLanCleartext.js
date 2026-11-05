const { withAndroidManifest } = require('@expo/config-plugins')

module.exports = config => withAndroidManifest(config, config => {
  const application = config.modResults.manifest.application?.[0]
  if (!application) throw new Error('Android application manifest is missing.')
  application.$['android:usesCleartextTraffic'] = 'true'
  return config
})
