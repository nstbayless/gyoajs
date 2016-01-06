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

//load config options:
var config = require("./config")

//----GYOA----//
var GyoaID = Struct({
  'gid': 'int',
  'rid': 'int'
})

var gyoa = ffi.Library('libgyoa',{
  'getBuildDate' : ['string', [ ] ],
  'loadModel' : ['pointer', ['string'] ],
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
  'editRoomBody' : [GyoaID, ['pointer', GyoaID, 'string']],
  'saveAll' : ['string', ['pointer','bool'] ],
  'parse_id' : [GyoaID, ['string'] ]
})

//load GYOA library:
var gyoa_model = gyoa.loadModel(config.model_path)
var gyoa_inittag = "rm&0x0"

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
var embed_cliff = fs.readFileSync('private/cliff.html').toString();
var embed_nav = "<tr><td style=\"border:0px\"><font size=2><p align=center><a href=tag"+gyoa_inittag+">[Restart]</a>"
  + " || <a href=\"javascript:history.go(-1)\">[Go Back]</a>"
  + " <del/></tr>"
var embed_script_test = fs.readFileSync('private/script_iotest.html').toString();

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
      return "<pre>"+raw_text.substring(6)+"</pre>"
    }
    //convert to paragraph form:
    var paragraphs = raw_text.split("\n\n")
    var html_text = ""
    for (var i in paragraphs){
      html_text+="<p>"+paragraphs[i]+"</p>\n";
    }
    return html_text;
  }
}

//retrieve room struct for given tag (e.g. room 0x0)
var getScenario = function(tag) {
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
        description: opt_text,
        destination: opt_href
      })
    }
    return {
      title: title,
      body: getHTMLBodyText(body),
      body_raw: body,
      opt: opt
    }
  }
  return null;
}

//makes a scenario (from a MAKE tag)
//adds it to the world
//returns tag for editing scenario
//returns empty string if error
var makeScenarioFromTag = function(tags) {
  if (tags[0].toLowerCase()==TAG_MAKE.toLowerCase()
    &&tags.length > 6) {
    //room id of src room
    gyoa_src_id = gyoa.parse_id(tags[3]+":"+tags[4]);
    gyoa_src_opt_j = parseInt(tags[6])
    if (gyoa_src_opt_j==NaN)
      return "";
    if (gyoa_src_opt_j>gyoa.getOptionCount(gyoa_model,gyoa_src_id))
      return "";
    gyoa_src_opt_id = gyoa.getOptionID(gyoa_model,gyoa_src_id,gyoa_src_opt_j);
    if (gyoa.getOptionDestination(gyoa_model,gyoa_src_id,gyoa_src_opt_j).gid!=-1)
      return "";
    var gyoa_dst_id = gyoa.makeRoom(gyoa_model)
    gyoa.editOptionDestination(gyoa_model,gyoa_src_id,gyoa_src_opt_id,gyoa_dst_id);
    //gyoa.saveAll(gyoa_model,false);
    return TAG_EDIT+"&"+gyoa_dst_id.gid+"x"+gyoa_dst_id.rid;
  }
  return "";
}

//send client HTML/javascript allowing them to edit room
var makeResponseForEditing = function(tag,req,res) {
  tags = tag.split(TAG_SEPARATOR);
  res.writeHead(200, {"Content-Type": "text/html"});
  res.write(embed_top);
  var room = getScenario(tag);
  if (room==null)
    res.write("<tr><td>Error: no room to edit.</td></tr>")
  else {
    res.write(embed_script_test
      .replace("_DOMAIN_",req.headers.host)
      .replace("_DEFTEXT_",room.body_raw)
      .replace("_ROOMID_",'"'+tags[1]+"x"+tags[2]+'"')
    );
  }
  res.write(embed_nav);
  res.write(embed_bot);
  res.end();
}

//send client HTML corresponding to the desired gyoa room and context
var makeResponseForTag = function(tag,request,response) {
  //allows editing of nav bar if scenario being viewed
  var tags=tag.split(TAG_SEPARATOR)
  if (tags[0]==TAG_NO_ROOM&&config.editable) {
    response.writeHead(200, {"Content-Type": "text/html"});
    response.write(embed_top);
    //user wants to edit room
    response.write(embed_cliff)
    //create scenario link: (random tag to prevent caching)
    response.write("<tr><td><a href=tag"+TAG_MAKE+"&"+tags.slice(1).join("&")
      +"&rand&"+Math.random()+">Write Scenario</a></td></tr>")
    response.write(embed_nav)
    response.write(embed_bot);
    response.end();
  } else if (tags[0]==TAG_EDIT&&config.editable) {
    makeResponseForEditing(tag,request,response);
  } else if (tags[0]==TAG_MAKE&&config.editable) {
    tag_redirect = makeScenarioFromTag(tags);
    response.writeHead(301,
    {Location: '/tag'+tag_redirect
    });
    response.end();
  } else {
    embed_nav_cust = embed_nav
    response.writeHead(200, {"Content-Type": "text/html"});
    response.write(embed_top);
    var room = getScenario(tag)
    if (room!=null) {
      response.write("<tr><th>"+room.title+"</th></tr>\n")
      response.write("<tr><td>"+room.body+"</td></tr>\n")
      if (room.opt.length>0) {
        response.write("<tr><td>")
        response.write("<p align=\"center\" size=24>Options</p>\n")
        for (var i=0;i<room.opt.length;i++) {
          if (room.opt[i].destination.substring(0,8).toLowerCase()=="tag-1x-1"||
              room.opt[i].destination.substring(0,TAG_NO_ROOM.length+3)
                .toLowerCase()=="tag"+TAG_NO_ROOM.toLowerCase()) {
            //no destination written
            if (config.editable)
              response.write("<p><i><a href="+room.opt[i].destination+">"+room.opt[i].description+"*</a></i></p>\n")
            else
              response.write("<p>"+room.opt[i].description+"</p>")
          } else
            //link option to destination
            response.write("<p><a href="+room.opt[i].destination+">"+room.opt[i].description+"</a></p>\n")
        }
        response.write("</td></tr>")
      }
        embed_nav_spl=embed_nav.split("<del/>")
        embed_nav_cust=embed_nav_spl[0]+"|| <a href=tagedit&"+tags[1]+"x"+tags[2]+">[Edit]</a>"+embed_nav_spl[1]
    } else { //no scenario found
      response.write("<tr><td> Error in URL tags (" + tag + ").<br/> No scenario found.</tr></td>\n"
                   + "<tr><td><a href=" + gyoa_inittag +">restart from scratch?</a></td></tr>\n")
    }
    response.write(embed_nav_cust)
    response.write(embed_bot);
    response.end();
  }
}

//send client the given file (in the public/ folder)
var makeResponseForFile = function(file,res) {
  //console.log("file requested: " + file)
  var uri = url.parse("public" +file).pathname;
  if (fs.existsSync(uri)) {
    var mimeType = mimeTypes[path.extname(uri).split(".")[1]];
    res.writeHead(200, mimeType);

    var fileStream = fs.createReadStream(uri);
    fileStream.pipe(res);
  } else {
    console.log("not exists: " + uri);
    res.writeHead(404, {'Content-Type': 'text/plain'});
    res.write('404 Not Found\n');
    res.end();
  }
}

//start serving...
var server = http.createServer(function(request, response) {
  if (request.url.substring(0,5)=="/pub/") {
    makeResponseForFile(request.url.substring(4),response);
  } else if (request.url.substring(0,5)=="/favi"){
    makeResponseForFile(request.url,response);
  } else if (request.url.substring(0,4)=="/tag") {
    makeResponseForTag(request.url.substring(4),request,response);
  } else {
    response.writeHead(404, {'Content-Type': 'text/plain'});
    response.write('404 Not Found\n');
    response.end();
  }
}).listen(config.port);

io = io.listen(server);
io.sockets.on('connection',function(socket) {
  console.log("connection received")
  socket.on('room_edit',function(data){
    if (config.editable) {
      var gyoa_rm_id = gyoa.parse_id(data.id);
      if (gyoa.roomExists(gyoa_model,gyoa_rm_id)) {
        gyoa.editRoomBody(gyoa_model,gyoa_rm_id,data.body)
      }
    }
    socket.emit('redirect',{url:'tagrm&'+data.id})
  });
});

console.log("Server running on port "+config.port);
