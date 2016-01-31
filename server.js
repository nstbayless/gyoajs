//imports
var http = require("http");
var fs = require("fs");
var path = require("path")
var url = require("url");
var ffi = require("ffi");
var ref = require('ref');
var Struct = require('ref-struct');
var sanitizeHtml = require('sanitize-html');
var io = require("socket.io");
var jsonfile = require("jsonfile");
var marked = require('marked');
var expandHomeDir = require('expand-home-dir')

//load config options:
var config = require("./config")
if (!config.path_is_dir)
  config.initStory=false;
if (config.model_path.slice(-1)!="/")
      config.model_path+="/"
config.model_path=expandHomeDir(config.model_path);

//----GYOA----//
var GyoaID = Struct({
  'gid': 'int',
  'rid': 'int'
})

var gyoa = ffi.Library('libgyoa',{
  'getBuildDate' : ['string', [ ] ],
  'directoryContainsModel' : ['bool', ['string'] ],
  'loadModel' : ['pointer', ['string'] ],
  'makeModel' : ['pointer', ['string'] ],
  'roomExists' : ['bool', ['pointer',GyoaID] ],
  'getRoomTitle' : ['string', ['pointer',GyoaID] ],
  'getRoomBody' : ['string', ['pointer',GyoaID] ],
  'getOptionCount' : ['int', ['pointer',GyoaID] ],
  'getOptionDescription' : ['string', ['pointer',GyoaID,'int'] ],
  'getOptionDestination' : [GyoaID, ['pointer',GyoaID,'int'] ],
  'getOptionID' : [GyoaID, ['pointer', GyoaID, 'int' ] ],
  'makeRoom' : [ GyoaID, ['pointer'] ],
  'editOptionDescription' : ['void' , ['pointer',GyoaID,GyoaID,'string'] ],
  'editOptionDestination' : ['void' , ['pointer',GyoaID,GyoaID,GyoaID] ],
  'addOption' : [GyoaID , ['pointer',GyoaID,'string',GyoaID] ],
  'removeOption' : ['void' , ['pointer',GyoaID,GyoaID] ],
  'editRoomTitle' : [GyoaID, ['pointer', GyoaID, 'string'] ],
  'editRoomBody' : [GyoaID, ['pointer', GyoaID, 'string'] ],
  'saveAll' : ['string', ['pointer','bool'] ],
  'parse_id' : [GyoaID, ['string'] ],
  //git commands:
  'libgitInit' : ['void', [ ] ],
  'libgitShutdown' : ['void', [ ] ],
  'isRepo' : ['bool', ['pointer'] ],
  'initRepo' : ['void', ['pointer'] ],
  'openRepo' : ['void', ['pointer'] ],
  'stageAndCommit' : ['void', ['pointer','string','string','string'] ]
})

//useful function from http://stackoverflow.com/a/32749571
function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (err) {
    return false;
  }
}

//load GYOA library:
gyoa.libgitInit();
var gyoa_story = []
dirs = fs.readdirSync(config.model_path);
if (!config.path_is_dir) {
  dirs = [''];
}
for (i=0;i<dirs.length;i++) {
  full_path=config.model_path+dirs[i]
  if (full_path.slice(-1)!="/")
      full_path+="/"
  var gyoa_model = null;
  if (gyoa.directoryContainsModel(full_path))
    gyoa_model = gyoa.loadModel(full_path)
  if (!gyoa_model&&config.path_is_dir) {
    console.log("Ignoring '" + dirs[i] + "'; not a gyoa repo")
    continue;
  } else console.log("gyoa repo found: " + dirs[i])
  var gyoa_allowgit = gyoa.isRepo(gyoa_model);
  if (gyoa_allowgit)
    gyoa.openRepo(gyoa_model)
  else if (config.commitEdits&&config.permanent)
    console.log("WARNING: config.commitEdits true but cannot "
      + "open git repo " + config.model_path+"; edits will not be comitted.");
  var gyoa_inittag = "rm&0x0"
  //load edit history (to see when last edits were made)
  var edit_history_path="logs/"+full_path
                              .replace(/[/~:\\`,-]/g,"_")+".json";
  var edit_history={};
  try{edit_history=jsonfile.readFileSync(edit_history_path)}
  catch (err) {
    console.log("unable to open edit history for " + edit_history_path);
    edit_history={};
  }
  gyoa_story.push({
    name: dirs[i],
    model: gyoa_model,
    allowgit: gyoa_allowgit,
    inittag: gyoa_inittag,
    full_path: full_path,
    edit_locks: {},
    edit_history: edit_history
  })
}

if (gyoa_story.length==0) {
  console.log("No stories found in " + config.model_path);
  process.exit(1);
}

//warning messages:
if (!config.permanent)
  console.log("WARNING: config.permanent=false; edits will not be saved.")
else //TODO: why are these both warnings >_>
  console.log("WARNING: config.permanent=true; edits will be saved.")

//load list of protected files
//TODO: different protections for different repos
var protected = {"_comment_": "THIS DOCUMENT IS FOR PROTECTING CERTAIN PAGES FROM EDITS.", "0x0":false}
var protected_path = "./protected.json";
try {
  if (!fileExists(protected_path)) {
    console.log("No " + protected_path + " file found, creating one...");
    jsonfile.writeFile(protected_path, protected, function (err) {
      console.error(err);
    })
  } else {
    protected=jsonfile.readFileSync(protected_path);
  }
} catch (err) {
  console.error(err);
  protected={}
}

//separates tags: tagrm&0x0
var TAG_SEPARATOR = /[x&:]/
//indicates cliffhanger -- no room written for this option
var TAG_NO_ROOM="cliff"
//indicates user wants to edit cliffhanger
var TAG_MAKE="decliff"
//indicates user wants to edit the room
var TAG_EDIT="edit"

//suggested from here http://stackoverflow.com/q/7268033
var mimeTypes = {
    "html": "text/html",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "png": "image/png",
    "js": "text/javascript",
    "css": "text/css"};
var embed_top = fs.readFileSync('private/embed_top.html').toString();
var embed_bot = fs.readFileSync('private/embed_bot.html').toString();
var embed_addnew = fs.readFileSync('private/addnew.html').toString();
var embed_cliff = fs.readFileSync('private/cliff.html').toString();
var embed_nav = "<tr><td style=\"border:0px\"><font size=2><p align=center>"
for (i=0;i<config.hotPages.length;i++) {
embed_nav+="<a href=\""+config.hotPages[i].href+"\">["+config.hotPages[i].link+"]</a> || "
}
embed_nav+= " <a href='/directory'>[Story Directory]</a> || "
embed_nav+= " <a href=\"javascript:history.go(-1)\">[Go Back]</a> <del/></p></font></td></tr>"

var embed_script_edit = fs.readFileSync('private/script_edit.html').toString();
var embed_script_edit_opt = fs.readFileSync('private/script_opt.html').toString();

//edit values indicate the protection status of the room:
EDIT_NO = 0        // not editable, reason unspecified
EDIT_YES = 1       // editable
EDIT_RSTATIC = 2   // no pages are editable as repo is not set to be writeable
EDIT_LOCKED = 3    // another user currently editing
EDIT_PROTECTED = 4 // admins have protected this page; it cannot be modified.

//returns true if the given room is under an edit lock
var getLocked = function(gyoa_rm_id,repo_n){
  var rm_str = gyoa_rm_id.gid+"_"+gyoa_rm_id.rid;
  var lock = gyoa_story[repo_n].edit_locks[rm_str];
  if (!lock)
    return false;
  var now = Date.now()+1;
  return (now-lock.date)<config.lockQuantum;
}

//returns remaining time (in seconds) before lock expires, or 0 if already expired
var getLockQuantum = function(gyoa_rm_id,repo_n){
  var rm_str = gyoa_rm_id.gid+"_"+gyoa_rm_id.rid;
  var lock = gyoa_story[repo_n].edit_locks[rm_str];
  var now = Date.now()+1;
  if (!lock)
    return 0;
  quantum = config.lockQuantum-(now-lock.date);
  if (quantum<0)
    return 0;
  return quantum/1000;
}

//returns true if the given lock code enables access to the given room.
var checkLockCode = function(lock_code,gyoa_rm_id,repo_n) {
  var rm_str = gyoa_rm_id.gid+"_"+gyoa_rm_id.rid;
  var lock = gyoa_story[repo_n].edit_locks[rm_str];
  if (!lock)
    throw new Error("no lock found on access for key " + rm_str);
  return lock_code==lock.lock_code;
}

//acquires a lock and returns the code to access it via accessLock
var acquireLock = function(gyoa_rm_id,repo_n) {
  var rm_str = gyoa_rm_id.gid+"_"+gyoa_rm_id.rid;
  lock_code = Math.floor(Math.random()*4000000);
  gyoa_story[repo_n].edit_locks[rm_str]={
    lock_code:lock_code,
    date:Date.now()
  }
  return lock_code;
}

//renews the given lock if the lock code matches or the lock is expired
//returns false on failure
var renewLock = function(lock_code,gyoa_rm_id,repo_n) {
  var rm_str = gyoa_rm_id.gid+"_"+gyoa_rm_id.rid;
  try {
    if (checkLockCode(lock_code,gyoa_rm_id,repo_n)) {
      gyoa_story[repo_n].edit_locks[rm_str].date=Date.now();
    }
    return true;
  } catch (err) {
    return false;
  }
  return false;
}

//expires the given lock (if the lock_code is correct)
//returns true on success
var unLock = function(lock_code,gyoa_rm_id,repo_n) {
  var rm_str = gyoa_rm_id.gid+"_"+gyoa_rm_id.rid;
  try {
    if (checkLockCode(lock_code,gyoa_rm_id,repo_n)) {
      gyoa_story[repo_n].edit_locks[rm_str]=undefined;
    }
    return true;
  } catch (err) {
    return false;
  }
  return false;
}

//returns true if editable
var getRoomEditable = function(gyoa_model, gyoa_rm_id, lock_code,repo_n){
  lock_code = lock_code || -1;
  if (!config.editable)
    return EDIT_RSTATIC;
  if (protected[gyoa_rm_id.gid+"x"+gyoa_rm_id.rid])
    return EDIT_PROTECTED;
  try {
    if (checkLockCode(lock_code,gyoa_rm_id,repo_n))
      return EDIT_YES;
  } catch (err) {}
  if (getLocked(gyoa_rm_id,repo_n)) {
    return EDIT_LOCKED;
  }
  return EDIT_YES;
}

LEDIT_NEVER="never"

var dateToPrettyString = function(date) {
  if (date==LEDIT_NEVER)
    return LEDIT_NEVER;
  //elapsed time since date, measured in seconds
  elapsed = (Date.now()-date)/1000;
  if (elapsed<2)
    return "a second ago";
  if (elapsed<91)
    return Math.floor(elapsed) + " seconds ago";
  elapsed/=60; //elapsed measured in minutes;
  if (Math.floor(elapsed)==1)
    return "a minute ago";
  if (elapsed<90)
    return Math.floor(elapsed) + " minutes ago";
  var d = new Date(date);
  elapsed/=60; //elapsed measured in hours
  if (elapsed<1.5)
    return "an hour ago"
  if (elapsed<48.5) // within 48 hours
    return Math.round(elapsed)+" hours ago"
  elapsed/=24; //elapsed measured in days
  if (elapsed<7)
    return Math.round(elapsed)+" days ago"
  if (elapsed<45)
    return "at " + d +" ("+Math.round(elapsed)+" days ago)"
  return  "at " + d;
}

var getDateRoomLastEdited = function(gyoa_model, gyoa_rm_id,repo_n) {
  last_edit=gyoa_story[repo_n].edit_history[gyoa_rm_id.gid+"_"+gyoa_rm_id.rid]||{};
  return dateToPrettyString(last_edit.date||LEDIT_NEVER);
}

var getDateGlobalLastEdited = function(repo_n) {
  last_edit=gyoa_story[repo_n].edit_history.global||{};
  return dateToPrettyString(last_edit.date||LEDIT_NEVER);
}

//replaces HTML special characters
var sanitizeForHTMLInsert = function(text){
  return text
    .replace(/&/g,"&amp;")
    .replace(/["]/g,"&quot;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
}

//get HTML representation of the given body text
var getHTMLBodyText = function(raw_text) {
  if (raw_text.substring(0,5).toLowerCase()=="@html") {
    //text is natively HTML. Just remove @html token and sanitize
    return sanitizeHtml(raw_text.substring(5), {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat([ 'img' ])
    });
  } else {
    //text is not HTML. reformat:
    if (raw_text.substring(0,6)=="@exact") {
      //display exactly as written:
      return "<pre>"+sanitizeForHTMLInsert(raw_text.substring(6))+"</pre>"
    } else {
      //default: text is in markdown
      return marked(sanitizeForHTMLInsert(raw_text));
    }
  }
}

//retrieve room struct for given tag (e.g. room 0x0)
var getScenario = function(tag,repo_n) {
  var gyoa_model = gyoa_story[repo_n].model;
  var tags=tag.split(TAG_SEPARATOR)
  if (tags.length>=3){
    gid=tags[1]
    rid=tags[2]
    var gyoa_rm_id = gyoa.parse_id(gid+":"+rid);
    if (!gyoa.roomExists(gyoa_model,gyoa_rm_id))
      return null;
    //get room description:
    var title = gyoa.getRoomTitle(gyoa_model,gyoa_rm_id)
    var body = gyoa.getRoomBody(gyoa_model,gyoa_rm_id)
    
    var opt = [ ]
    var opt_n = gyoa.getOptionCount(gyoa_model,gyoa_rm_id);
    for (var i=0;i<opt_n;i++){
      var opt_text = gyoa.getOptionDescription(gyoa_model,gyoa_rm_id,i);
      var dst_id = gyoa.getOptionDestination(gyoa_model,gyoa_rm_id,i);
      var opt_href = "tagrm&"+dst_id.gid + "x" + dst_id.rid;
      if (dst_id.gid==-1&&config.editable) {
        //no destination; link to edit-room page
        opt_href="tag"+TAG_NO_ROOM+"&src&"+tag+"&opt&"+i
      }
      opt.push({
        description: sanitizeForHTMLInsert(opt_text),
        destination: opt_href,
        raw_destination: dst_id.gid + "x" + dst_id.rid
      })
    }
    return {
      title: title,
      body: getHTMLBodyText(body),
      body_raw: body,
      opt: opt,
      gyoa_id: gyoa_rm_id,
      gyoa_model: gyoa_model
    }
  }
  return null;
}

//makes a scenario (from a MAKE tag)
//adds it to the world
//returns tag for editing scenario
//returns empty string if error
var makeScenarioFromTag = function(tags,repo_n) {
  var gyoa_model = gyoa_story[repo_n].model;
  //TODO: consider whether to allow adding new room if src room is uneditable.
  if (tags[0].toLowerCase()==TAG_MAKE.toLowerCase()
    &&tags.length > 6) {
    //room id of src room
    gyoa_src_id = gyoa.parse_id(tags[3]+":"+tags[4]);
    gyoa_src_opt_j = parseInt(tags[6])
    if (!config.editable)
      return "";
    if (gyoa_src_opt_j==NaN)
      return "";
    if (gyoa_src_opt_j>gyoa.getOptionCount(gyoa_model,gyoa_src_id))
      return "";
    gyoa_src_opt_id = gyoa.getOptionID(gyoa_model,gyoa_src_id,gyoa_src_opt_j);
    if (gyoa.getOptionDestination(gyoa_model,gyoa_src_id,gyoa_src_opt_j).gid!=-1)
      return "";
    var gyoa_dst_id = gyoa.makeRoom(gyoa_model)
    gyoa.editOptionDestination(gyoa_model,gyoa_src_id,gyoa_src_opt_id,gyoa_dst_id);
    //set up dst room:
    gyoa.editRoomTitle(gyoa_model,gyoa_dst_id,"");
    gyoa.editRoomBody(gyoa_model,gyoa_dst_id,"This room is under construction. Press [edit] to edit it.");
    return TAG_EDIT+"&"+gyoa_dst_id.gid+"x"+gyoa_dst_id.rid;
  }
  return "";
}

//send client HTML/javascript allowing them to edit room
var makeResponseForEditing = function(tag,req,res,repo_n) {
  var gyoa_model = gyoa_story[repo_n].model;
  tags = tag.split(TAG_SEPARATOR);
  res.writeHead(200, {"Content-Type": "text/html"});
  res.write(embed_top);
  var room = getScenario(tag,repo_n);
  var editable = getRoomEditable(room.gyoa_model,room.gyoa_id,null,repo_n)
  if (room==null)
    res.write("<tr><td>Error: no room to edit.</td></tr>")
  else if (editable!=EDIT_YES)
    res.write("<tr><td>Error: edit not permitted (code " +editable+")</td></tr>")
  else {
    var opt_html = embed_script_edit_opt;
    var defopt = "";
    for (var i=0;i<room.opt.length;i++) {
      defopt+="<tr>"+opt_html
               .replace("_OPTEXT_","\""+room.opt[i].description+"\"")
               .replace("_DST_","\""+room.opt[i].raw_destination+"\"")
               +"</tr>\n"
    }
    res.write(embed_script_edit
      .replace("_DOMAIN_",req.headers.host)
      .replace("_DEFTITLE_",sanitizeForHTMLInsert(room.title))
      .replace("_DEFBODY_",sanitizeForHTMLInsert(room.body_raw))
      .replace(/_ROOMID_/g,'"'+tags[1]+"x"+tags[2]+'"')
      .replace(/_REPO_/g,repo_n)
      .replace("_ADDOPT_",opt_html
        .replace("_DST_","''")
        .replace("_OPTEXT_","'new option (\"+(row_c+1)+\")...'")//row_c is a client-side var
        .replace(/\n/g," "))
      .replace("_DEFOPT_",defopt)
    );
  }
  res.write(embed_nav.replace("_REPO_",repo_n));
  res.write(embed_bot);
  res.end();
}

//send client HTML corresponding to the desired gyoa room and context
var makeResponseForScenario = function(tag,response,repo_n) {
  var gyoa_model = gyoa_story[repo_n].model;
  var tags=tag.split(TAG_SEPARATOR)
  embed_nav_cust = embed_nav
  var edit_info_string = "";
  var global_edit_info_string = "";
  response.writeHead(200, {"Content-Type": "text/html"});
  response.write(embed_top);
  var room = getScenario(tag,repo_n)
  if (room!=null) {
    //get page protection status:
    var editable = getRoomEditable(room.gyoa_model,room.gyoa_id,null,repo_n);
    var img_lock = ""
    var lock_path = "/pub/protect.png";
    var alt_text="This page has been protected to prevent vandalism"
    if (editable==EDIT_LOCKED) {
      var lock_path = "/pub/lock.png";
      alt_text="This page is currently being edited by another user";
    }
    if (editable!=EDIT_YES&&config.editable)
      img_lock='<span style="position:absolute;"><img src="'+lock_path+'" align="right" style="position:absolute;top:-4px;left:20px;" alt="'+alt_text+'" title="' + alt_text + '"/></span>'
    response.write("<tr><th>"+(room.title||"&nbsp;")+img_lock+"</th></tr>\n")
    response.write("<tr><td>"+room.body+"</td></tr>\n")
    if (room.opt.length>0) {
      response.write("<tr><td>")
      response.write("<p align=\"center\">Options</p>\n")
      for (var i=0;i<room.opt.length;i++) {
        if (room.opt[i].raw_destination.substring(0,3)=="-1x") {
          //no destination written
          if (config.editable&&editable!=EDIT_LOCKED) {
            response.write("<p>"+(i+1)+". <i><a href=\""+room.opt[i].destination+"\">"+room.opt[i].description+"*</a></i></p>\n")
          }
          else
            response.write("<p>"+(i+1)+". "+room.opt[i].description+"</p>")
        } else
          //link option to destination
          response.write("<p>"+(i+1)+". <a href=\""+room.opt[i].destination+"\">"+room.opt[i].description+"</a></p>\n")
      }
      response.write("</td></tr>")
    }
    if (config.editable) {
      leditdate = getDateGlobalLastEdited(repo_n)
      //mention date of last edit globally
      if (leditdate!=LEDIT_NEVER) {
        global_edit_info_string="The last edit to this story overall was " + leditdate+" <a href=\"" + gyoa_story[repo_n].edit_history.global.where + "\">here</a>";
      }
    }
    if (getRoomEditable(room.gyoa_model,room.gyoa_id,null,repo_n)==EDIT_YES) {
      leditdate = getDateRoomLastEdited(room.gyoa_model,room.gyoa_id,repo_n)
      //mention date of last edit
      if (leditdate!=LEDIT_NEVER) {
        edit_info_string="<font size=1 color=grey>This scenario was last edited " + leditdate+"</font>";
      }
    }
    if (getRoomEditable(room.gyoa_model,room.gyoa_id,null,repo_n)==EDIT_LOCKED) {
      var expiry = "";
      var quantum = getLockQuantum(room.gyoa_id,repo_n);
      if (config.lockQuantum-quantum*1000 > config.lockHeartbeat*1.2)
        expiry = "(lock expires in " + Math.ceil(quantum) + " seconds)";
      edit_info_string = "<font size=2 color=#383838><b>This scenario is currently being edited " + expiry + "</b></font>";
    }
    if (getRoomEditable(room.gyoa_model,room.gyoa_id,null,repo_n)==EDIT_YES) {
      //add edit button to navbar
      embed_nav_spl=embed_nav.split("<del/>")
      embed_nav_cust=embed_nav_spl[0]+"|| <a href=\"tagedit&"+tags[1]+"x"+tags[2]+"\">[Edit]</a>"+embed_nav_spl[1]
    }
  } else {//no room found
    response.write("<tr><td> Error in URL tags (" + tag + ").<br/> No scenario found.</tr></td>\n"
                 + "<tr><td><a href=tag" + gyoa_inittag +">restart from scratch?</a></td></tr>\n")
  }
  response.write(embed_nav_cust.replace("_REPO_",repo_n))
  if(edit_info_string.length>0||global_edit_info_string.length>0) {
    response.write("\n<tr><td style=\"border:0px\"><i><center>")
    response.write(edit_info_string)
    response.write("<font size=1 color=grey>");
    if (edit_info_string.length!=0&&global_edit_info_string.length!=0)
      response.write(" ~ ")
    response.write(global_edit_info_string)
    response.write("</font></center></i></td></tr>")
  }
  response.write(embed_bot);
  response.end();
}

//respond with HTML for given tag (e.g. view scenario, edit, etc.)
var makeResponseForTag = function(tag,request,response,repo_n) {
  var gyoa_model=gyoa_story[repo_n].model;
  //allows editing of nav bar if scenario being viewed
  var tags=tag.split(TAG_SEPARATOR)
  if (tags[0]==TAG_NO_ROOM&&config.editable) {
    //cliffhanger
    response.writeHead(200, {"Content-Type": "text/html"});
    response.write(embed_top);
    var cliff_replace_message = "";
    if (!config.editable)
      cliff_replace_message="<br/>Unfortunately this story is read-only "
        + "so you'll have to ask the admin for permission to write.";
    else if (!config.permanent)
       cliff_replace_message="<br/> Warning: this story does not support permanent edits."
         + " Even after saving your changes your contribution could be lost at any time.";
    //user wants to edit room
    response.write(embed_cliff
                     .replace("__CLIFFOPT__",cliff_replace_message))
    if (config.editable) //create scenario href: (random tag to prevent caching)
      response.write("<tr><td><a href=tag"+TAG_MAKE+"&"+tags.slice(1).join("&")
        +"&rand&"+Math.random()+">Write Scenario</a></td></tr>")
    response.write(embed_nav.replace(/_REPO_/g,repo_n))
    response.write(embed_bot);
    response.end();
  } else if (tags[0]==TAG_MAKE&&config.editable) {
    //create scenario and then redirect client to edit page
    tag_redirect = "/tag"+makeScenarioFromTag(tags,repo_n);
    if (repo_n)
      tag_redirect="/"+repo_n+tag_redirect;
    response.writeHead(302,{Location: tag_redirect});
    response.end();
    console.log("scenario created: " + tag_redirect);
  } else if (tags[0]==TAG_EDIT&&config.editable) {
    //client edits an existing page
    makeResponseForEditing(tag,request,response,repo_n);
  } else {
    //client views a room
    makeResponseForScenario(tag,response,repo_n);
  }
}

//send client the given file
var makeResponseForFile = function(file,res) {
  //console.log("file requested: " + file)
  var uri = url.parse(file).pathname;
  if (fs.existsSync(uri)) {
    //file found
    var mimeType = mimeTypes[path.extname(uri).split(".")[1]];
    res.writeHead(200, mimeType);

    var fileStream = fs.createReadStream(uri);
    fileStream.pipe(res);
  } else {
    //file not found
    console.log("file not found: " + uri);
    res.writeHead(404, {'Content-Type': 'text/plain'});
    res.write('404 Not Found\n');
    res.end();
  }
}

// send client story directory listing
var makeResponseForDirectory = function(req,res) {
  res.writeHead(200, {"Content-Type": "text/html"});
  res.write(embed_top);
  res.write("<tr><th>Story Directory</th></tr>\n")
  res.write("<tr><td>")
  for (var i=0;i<gyoa_story.length;i++){
    res.write("<p>"+i+". <a href='/"+i+"/'>"+gyoa_story[i].name+"</a></p>")
  }
  res.write("</td></tr>\n")
  if (config.initStory) {
    res.write("<tr><td><p><a href='/addnew'>Create new story!</a></p></td></tr>");
  }
  res.write(embed_bot);
  res.end();
}

// send client html for adding new story
var makeResponseForAddNew = function(req,res) {
  res.writeHead(200, {"Content-Type": "text/html"});
  res.write(embed_top);
  res.write(embed_addnew.replace("_DOMAIN_",req.headers.host));
  res.write(embed_bot);
  res.end();
}

// adds a new repo at the given directory relative to config.model_path
var makeNewRepo = function(dir) {
  if (!config.initStory)
    return;
  full_path=config.model_path+dir
  if (full_path.slice(-1)!="/")
      full_path+="/"
  var gyoa_model = gyoa.makeModel(full_path);
  var gyoa_rm_id = gyoa.makeRoom(gyoa_model);
  gyoa.editRoomTitle(gyoa_model,gyoa_rm_id,"New Story")
  gyoa.editRoomBody(gyoa_model,gyoa_rm_id,"Start off your story here. _Markdown Supported_")
  gyoa.saveAll(gyoa_model,true);
  gyoa.initRepo(gyoa_model);
  var gyoa_allowgit = true
  if (gyoa_allowgit)
    gyoa.openRepo(gyoa_model)
  var gyoa_inittag = "rm&0x0"
  //load edit history (to see when last edits were made)
  var edit_history_path="logs/"+full_path
                              .replace(/[/~:\\`,-]/g,"_")+".json";
  var edit_history={};
  try{edit_history=jsonfile.readFileSync(edit_history_path)}
  catch (err) {
    console.log("unable to open edit history for " + edit_history_path);
    edit_history={};
  }
  gyoa_story.push({
    name: dir,
    model: gyoa_model,
    allowgit: gyoa_allowgit,
    inittag: gyoa_inittag,
    full_path: full_path,
    edit_locks: {},
    edit_history: edit_history
  })
}

//---SET UP SERVER---//

//start serving...
var server = http.createServer(function(request, response) {
  repo_n=parseInt(request.url.substring(1))||0;
  if (request.url.substring(0,5)=="/pub/") {
    //request for public file
    makeResponseForFile("public"+request.url.substring(4),response);
  } else if (request.url.substring(0,6)=="/repo/"){
    //request for public file in repo ext/ folder
    var file_path = gyoa_story[0].full_path;
    if (file_path.slice(-1)!="/")
      file_path+="/"
    file_path+="ext/"+request.url.substring(6);
    makeResponseForFile(file_path,response);
  } else if (repo_n<gyoa_story.length&&request.url.match(/\/[0-9]*\/repo\//)){
    //request for public file in repo ext/ folder
    var file_path = gyoa_story[repo_n].full_path;
    if (file_path.slice(-1)!="/")
      file_path+="/"
    file_path+="ext/"+request.url.substring(request.url.indexOf("/repo/")+6);
    makeResponseForFile(file_path,response);
  } else if (request.url.substring(0,5)=="/favi"){
    //request for favicon
    makeResponseForFile("public"+request.url,response);
  } else if (request.url.substring(0,4)=="/tag") {
    //request for tag* page, e.g. gyoa scenario, edit page, etc.
    makeResponseForTag(request.url.substring(4),request,response,0);
  } else if (request.url=="/") {
    makeResponseForTag(gyoa_inittag,request,response,0); 
  } else if (repo_n<gyoa_story.length&&request.url.match(/\/[0-9]*\/tag/)) {
    //request for tag* page, e.g. gyoa scenario, edit page, etc.
    makeResponseForTag(request.url.substring(request.url.indexOf("/tag")+4),request,response,repo_n);
  } else if (repo_n<gyoa_story.length&&request.url.match(/\/[0-9]*\//)) {
    makeResponseForTag(gyoa_inittag,request,response,repo_n); 
  } else if (request.url=="/directory"&&(gyoa_story.length>1||config.initStory)) {
    makeResponseForDirectory(request,response);
  } else if (request.url=="/addnew"&&config.initStory) {
    makeResponseForAddNew(request,response);
  } else {
    //not sure what the client wants
    response.writeHead(404, {'Content-Type': 'text/plain'});
    response.write('404 Not Found\n');
    response.end();
  }
}).listen(config.port);

//listen for socket connections (used in edit mode)
io = io.listen(server);
io.sockets.on('connection',function(socket) {
  console.log("connection received")
  socket.on('acquire_lock',function(data){
    var gyoa_rm_id = gyoa.parse_id(data.id);
    if (typeof(data.id)!='string')
     socket.emit('lock_code',-1);
    else if (getLocked(gyoa_rm_id,data.repo_n))
      socket.emit('lock_code',-1);
    else {
      var lock_code = acquireLock(gyoa_rm_id,data.repo_n)
      socket.emit('lock_code',lock_code);
    }
  })

  socket.on('renew_lock',function(data){
    try {
      console.log("ping renew lock " + data.lock_code + " for room " + data.id + " in story " + data.repo_n);
      var gyoa_rm_id = gyoa.parse_id(data.id);
      if (typeof(data.id)!='string')
        socket.emit('lock_code',-1);
      else if (!checkLockCode(data.lock_code,gyoa_rm_id,repo_n))
        socket.emit('lock_code',-1);
      else if (!renewLock(data.lock_code,gyoa_rm_id,repo_n))
        socket.emit('lock_code',-1)
      else
        socket.emit('lock_code',data.lock_code);
    } catch (err) {socket.emit('lock_code',-1)}
  })

  socket.on('add_new', function(data) {
    //client wants to add a new gyoa repo
    if (config.editable&&config.initStory) {
      var ERR_START = "Error: "
      try {
        if (typeof(data.author)!='string')
          throw ERR_START + "submission invalid: author not string"
        if (typeof(data.title)!='string')
          throw ERR_START + "submission invalid: title not string"
        if (!data.title.match(/^[-\w]+$/))
          throw ERR_START + "submission invalid: title invalid"
        if (data.title.length<3)
         throw ERR_START + "submission invalid: title must be at least 3 characters"
        if (data.author.length<3)
         throw ERR_START + "submission invalid: author must be at least 3 characters"
        for (var i = 0;i<gyoa_story.length;i++)
          if (data.title.toLowerCase()==gyoa_story[i].name.toLowerCase())
            throw ERR_START + "submission invalid: that title is already in use"
        var gs_next=gyoa_story.length
        makeNewRepo(data.title);
        socket.emit('redirect',{url: '/'+gs_next+'/'});
      } catch (err) {
        console.log(err)
        //inform client of error
        client_errtext ="An unknown error occurred"
        if (typeof(err)=="string")
          if (err.substring(0,ERR_START.length)==ERR_START)
            client_errtext=err.substring(ERR_START.length)
        socket.emit('errorr',{err:client_errtext})
      }
    }
  })

  socket.on('room_edit',function(data){
    //client edits a room:
    try {
      var ERR_START = "GYOAJS_ERR: "
      if (config.editable) {
        //check data from client in valid format:
        if (typeof(data.id)!='string')
          throw ERR_START + "submission invalid: id not string"
        if (typeof(data.repo_n)!='number')
          throw ERR_START + "submission invalid: repo_n not a number"
        if (typeof(data.body)!='string')
          throw ERR_START + "submission invalid: body not string"
        if (typeof(data.title)!='string')
          throw ERR_START + "submission invalid: title not string"
        //check all client option dest-IDs are valid:
        for (var i = 0;i<data.opt.length;i++) {
          if (typeof(data.opt[i].description)!='string'
            || typeof(data.opt[i].destination)!='string')
            throw ERR_START+"submission invalid (type error): option "+(i+1)
          data.opt[i].parse_id=gyoa.parse_id(data.opt[i].destination.trim())
          if (data.opt[i].parse_id.gid==-1&&data.opt[i].parse_id.rid==-2)
            throw ERR_START+"submission invalid (wrong format or error id):"
              + "option destination "+(i+1)+": " + data.opt[i].destination
        }
        var gyoa_rm_id = gyoa.parse_id(data.id);
        var gyoa_model = gyoa_story[data.repo_n].model
        if (gyoa_rm_id.gid==-1&&gyoa_rm_id.rid==-2)//error in parsing
          throw ERR_START+"Error parsing ID of room ("+data.id+")"
        if (gyoa.roomExists(gyoa_model,gyoa_rm_id)) {
          var editable=getRoomEditable(gyoa_model,gyoa_rm_id,data.lock_code,repo_n);
          if (editable==EDIT_YES) {
            //update edit history:
            gyoa_story[data.repo_n].edit_history.global={
              date: Date.now(),
              user: ""
            };
            gyoa_story[data.repo_n].edit_history[gyoa_rm_id.gid+"_"+gyoa_rm_id.rid]=gyoa_story[data.repo_n].edit_history.global;
            gyoa_story[data.repo_n].edit_history.global.where="/tagrm&"+gyoa_rm_id.gid+"x"+gyoa_rm_id.rid;
            console.log(gyoa_story[data.repo_n].edit_history.global);
            //edit repo version of room:
            gyoa.editRoomBody(gyoa_model,gyoa_rm_id,data.body)
            gyoa.editRoomTitle(gyoa_model,gyoa_rm_id,data.title)
  
            //number of options submitted by user (total number of options)
            var opt_user_c = data.opt.length
            //number of options currently in repo
            var opt_gyoa_c = gyoa.getOptionCount(gyoa_model,gyoa_rm_id)
  
            //GyoaIDs of options to be removed:
            var tombstones = []
  
            //add options into repo:
            for (var i = 0;i<Math.max(opt_gyoa_c,opt_user_c);i++) {
              if (i<opt_gyoa_c&&i<opt_user_c) {
                //option exists both in user submission and in repo
                var gyoa_opt_id = gyoa.getOptionID(gyoa_model,gyoa_rm_id,i)
                //set option in repo to equal user-submitted option:
                gyoa.editOptionDescription(gyoa_model,gyoa_rm_id,gyoa_opt_id,data.opt[i].description)
                gyoa.editOptionDestination(gyoa_model,gyoa_rm_id,gyoa_opt_id,data.opt[i].parse_id)
              } else if (i<opt_gyoa_c) {
                //option exists only in repo; delete option
                var gyoa_opt_id = gyoa.getOptionID(gyoa_model,gyoa_rm_id,i)
                //mark option as tombstone:
                tombstones.push(gyoa_opt_id);
              } else if (i<opt_user_c) {
                //option does not exist in repo; add option
                gyoa.addOption(gyoa_model,gyoa_rm_id,data.opt[i].description,data.opt[i].parse_id)
              }
            }
            //delete tombstones:
            for (var i=0;i<tombstones.length;i++) {
              gyoa.removeOption(gyoa_model,gyoa_rm_id,tombstones[i])
            }
            //unlock:
            unLock(lock_code,gyoa_rm_id,data.repo_n);
          } else {
            throw ERR_START + "Cannot edit; page is locked (edit code "+editable+")"
          }
        } else {
          throw ERR_START + "Cannot edit -- this room does not appear to exist."
        }
      } else {
        throw ERR_START + "Cannot make changes -- write-rights locked! (For whole repo)"
      }
      var gyoa_model = gyoa_story[data.repo_n].model
      //random value added to fool cache on page reload:
      var redirect_url = '/tagrm&'+data.id+"&rand&"+Math.random()
      if (data.repo_n)
        redirect_url = "/"+data.repo_n+ redirect_url;
      socket.emit('redirect',{url:redirect_url}) 
      //edit complete: update edit history
      jsonfile.writeFile(edit_history_path, gyoa_story[data.repo_n].edit_history, function (err) {
        console.error(err)
      })
      //save
      if (config.permanent){ 
        console.log("saving edit...")
        console.log(gyoa.saveAll(gyoa_model,false));
        if (config.commitEdits) {
          if (gyoa_allowgit) {
            gyoa.stageAndCommit(gyoa_model,"gyoa_server","?@?","room " + gyoa_rm_id.gid+":"+gyoa_rm_id.rid + " edited")
            console.log("committed edit.")
          } else
            console.log("config.commitEdits true but cannot "
              + "open git repo " + config.model_path);
        }
      } 
    } catch (err) {
      console.log(err)
      //inform client of error
      client_errtext ="An unknown error occurred"
      if (typeof(err)=="string")
        if (err.substring(0,ERR_START.length)==ERR_START)
          client_errtext=err.substring(ERR_START.length)
      socket.emit('errorr',{err:client_errtext})
    }
  });
});

console.log("Server running on port "+config.port);
console.log("Connect to http://localhost:"+config.port);
