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
  'roomExists' : ['bool', ['pointer',GyoaID] ],
  'getRoomTitle' : ['string', ['pointer',GyoaID] ],
  'getRoomBody' : ['string', ['pointer',GyoaID] ],
  'getOptionCount' : ['int', ['pointer',GyoaID] ],
  'getOptionDescription' : ['string', ['pointer',GyoaID,'int'] ],
  'getOptionDestination' : [GyoaID, ['pointer',GyoaID,'int'] ],
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
    html_text+=""
    return html_text;
  }
}

//retrieve room struct for given tag (e.g. room 0x0)
var getScenario = function(tag) {
  var tags=tag.split("x")
  if (tags.length>=2){
    gid=tags[0]
    rid=tags[1]
    var gyoa_rm_id = gyoa.parse_id(gid+":"+rid);
    if (!gyoa.roomExists(gyoa_model,gyoa_rm_id))
      return null;
    //get room description:
    var title = gyoa.getRoomTitle(gyoa_model,gyoa_rm_id)
    var body = getHTMLBodyText(gyoa.getRoomBody(gyoa_model,gyoa_rm_id))
    
    var opt = [ ]
    var opt_n = gyoa.getOptionCount(gyoa_model,gyoa_rm_id);
    for (var i=0;i<opt_n;i++){
      var opt_text = gyoa.getOptionDescription(gyoa_model,gyoa_rm_id,i);
      var dst_id = gyoa.getOptionDestination(gyoa_model,gyoa_rm_id,i);
      var opt_href = dst_id.gid + "x" + dst_id.rid;
      console.log(opt_href + ":" + opt_text);
      opt.push({
        description: opt_text,
        destination: opt_href
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

//send client HTML corresponding to the desired gyoa room and context
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
       if (room.opt[i].destination.substring(0,5)=="-1x-1") {
         //no destination written
         if (config.editable)
           response.write("<p><a href="+room.opt[i].destination+">"+room.opt[i].description+"</a>*</p>\n")
         else
           response.write("<p>"+room.opt[i].description+"</p>")
       } else
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
http.createServer(function(request, response) {
  if (request.url.substring(0,5)=="/pub/") {
    makeResponseForFile(request.url.substring(4),response);
  } else {
    makeResponseForTag(request.url.substring(1),response);
  }
}).listen(config.port);

console.log("Server running on port "+config.port);
