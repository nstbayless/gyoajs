//imports
var http = require("http");
var fs = require("fs");
var path = require("path")
var url = require("url");

//----GYOA----//

//ffi import

var ffi = require("ffi");
var gyoa = ffi.Library('libgyoa',{
  'getBuildDate' : ['string', [ ] ]
})

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

var getScenario = function(tag) {
  var tags=tag.substring(1).split("x")
  if (tags.length>=2){
    gid=tags[0]
    rid=tags[1]
    var header="Header"
    var body = "Body text for room #"+gid
    
    var opt = [ ]
    for (var i=0;i<3;i++){
      opt.push({
        description: ("go to room "+i),
        destination: (i+"x0")
      })
    }
    return {
      header: header,
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
    response.write("<tr><th>"+room.header+"</th></tr>\n")
    response.write("<tr><td>"+room.body+"</td></tr>\n")
    if (room.opt.length>0) {
      response.write("<tr><td>")
      response.write("<p align=\"center\" size=24>Options</p>\n")
      for (var i=0;i<room.opt.length;i++) {
       response.write("<p><a href="+room.opt[i].destination+">"+room.opt[i].description+"</a></p>\n")
      }
      response.write("</td></tr>")
    }
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
