window.captions.on(data=>{document.getElementById('original').textContent=data.text??'';document.getElementById('translation').textContent=data.tr??'';});
