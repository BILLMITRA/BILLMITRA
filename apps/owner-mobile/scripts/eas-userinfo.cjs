// Work around Node's Windows user lookup failing in restricted terminals.
const os = require('node:os');
const originalUserInfo = os.userInfo;

os.userInfo = function userInfo(options) {
  try {
    return originalUserInfo(options);
  } catch (error) {
    if (error?.code !== 'ERR_SYSTEM_ERROR' || !process.env.USERPROFILE) {
      throw error;
    }

    return {
      username: process.env.USERNAME || 'USER',
      uid: -1,
      gid: -1,
      shell: null,
      homedir: process.env.USERPROFILE,
    };
  }
};
