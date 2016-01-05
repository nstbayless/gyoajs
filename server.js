//imports
var http = require("http");
var fs = require("fs");
var path = require("path")
var url = require("url");
var ffi = require("ffi");
var ref = require('ref');
var Struct = require('ref-struct');
var sanitizeHtml = require('sanitize-html');

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
  'getRoomTitle' : ['string', ['pointer',GyoaID] ],
  'getRoomBody' : ['string', ['pointer',GyoaID] ],
  'parse_id' : [GyoaID, ['string'] ],
})

//load GYOA library:
var gyoa_model = gyoa.loadModel(config.model_path)
var gyoa_inittag = "0x0"

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

var getHTMLBodyText = function(raw_text) {
  if (raw_text.substring(0,5).toLowerCase()=="@html") {
    //text is natively HTML. Just remove @html token and sanitize
    return sanitizeHtml(raw_text.substring(5), {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat([ 'img' ])
    });
  } else {
    //text is not HTML. reformat:
    var paragraphs = raw_text.split("\n\n")
    var html_text = ""
    var first=true;
    for (var i in paragraphs){
      if (!first)
        html_text+="<br/><br/>"
      html_text+=paragraphs[i];
      first=false;
    }
    return html_text;
  }
}

var getScenario = function(tag) {
  var tags=tag.substring(1).split("x")
  if (tags.length>=2){
    gid=tags[0]
    rid=tags[1]
    var gyoa_rm_id = gyoa.parse_id(gid+":"+rid);

    //get room description:
    var title = gyoa.getRoomTitle(gyoa_model,gyoa_rm_id)
    var body = getHTMLBodyText(gyoa.getRoomBody(gyoa_model,gyoa_rm_id))
    
    var opt = [ ]
    for (var i=0;i<3;i++){
      opt.push({
        description: ("go to room "+i),
        destination: (i+"x0")
      })
    }
    return {
      title: title,
      body: body,
      opt: opt
    }
  }
  return null;
}

var makeResponseForTag = function(tag,response) {
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
       response.write("<p><a href="+room.opt[i].destination+">"+room.opt[i].description+"</a></p>\n")
      }
      response.write("</td></tr>")
    }
  } else { //no scenario found
    response.write("<tr><td> Error in URL tags (" + tag + ").<br/> No scenario found.</tr></td>\n"
                   + "<tr><td><a href=" + gyoa_inittag +">restart from scratch?</a></td></tr>\n")
  }
  response.write(embed_bot);
  response.end();
}

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
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.write('404 Not Found\n');
    res.end();
  }
}

http.createServer(function(request, response) {
  if (request.url.substring(0,5)=="/pub/") {
    makeResponseForFile(request.url.substring(4),response);
  } else {
    makeResponseForTag(request.url,response);
  }
}).listen(8888);

console.log("Server running on port 8888");
