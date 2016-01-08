var config = {}

//path to adventure data
config.model_path = "./data"

//port to listen on
config.port=8888

//allow users to edit adventure?
config.editable=true;

//should edits be permanent (saved to disk?)
config.permanent=false;

//should stageAndCommit every time a user makes an edit
//ignored if config.permanent is set to false
config.commitEdits=true;

//export module (for use in server.js)
module.exports = config
