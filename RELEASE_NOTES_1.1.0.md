# TaskFlow 1.1.0

- Search and select multiple employees in project/task forms on web, Electron and Android.
- Provision employees with a name, username, email and temporary password; copy the credentials once for private sharing.
- Sign in with username or email; require a different confirmed password before workspace/API/socket access. Argon2id hashing and session rotation invalidate the temporary credential.
- Keep application updates accessible in Notifications after dismissing the popup. Show Install Update, Refresh Application or Already Installed according to platform and installed version.
- Resume desktop installation through an origin-checked IPC bridge, including a downloaded update awaiting restart.
- Derive Android versionName/versionCode from the release package version for local and CI builds.

Validation: PostgreSQL API integration/security tests (26), frontend component tests (7), desktop updater/path tests (2), mobile configuration test (1), desktop and Pixel browser end-to-end workflows (2), static web build and Electron UI/startup smoke tests passed. Signed Android release built locally. Real Android device installation remains unverified because no device is connected. iOS is not implemented by this repository.

Update cards derive from the latest release and the running binary version, with one card per client rather than per-user database rows; dismissing a popup never removes that card. Android uses the system browser to download the signed APK, followed by user approval in the Android package installer.
