var config = {}

// path to adventure data
config.model_path = "~/git/gyoa-test-repo"

// port to listen on
config.port=8866

// allow users to edit adventure?
config.editable=true;

// should edits be permanent (saved to disk?)
config.permanent=true;

// should stageAndCommit every time a user makes an edit
// ignored if config.permanent is set to false
config.commitEdits=true;

// (recommended) should clients have to acquire a lock to edit.
config.editLocks=true

// time after which a user's edit lock expires, in milliseconds
config.lockQuantum=25*1000; // 25 seconds

// interval at which client should renew lock (should be less than lockQuantum)
config.lockHeartbeat=7*1000; // 7 seconds

// export module (for use in server.js)
module.exports = config
