const queueFull=()=>Object.assign(new Error('视频处理队列已满，请稍后重试'),{code:'COLLECTOR_VIDEO_QUEUE_FULL'});

// One TaskManager owns this queue. It limits only ffmpeg work; Collection
// downloads and the existing 4/8-task scheduler remain independent.
export function createVideoWorkQueue({maxPending=64}={}){
    if(!Number.isInteger(maxPending)||maxPending<1)
        throw new Error('视频处理等待上限必须为正整数');
    let active=0;
    const pending=[];
    const advance=()=>{
        if(active||!pending.length)
            return;
        const job=pending.shift();
        job.signal?.removeEventListener('abort',job.abort);
        if(job.signal?.aborted){
            job.reject(job.signal.reason);
            advance();
            return;
        }
        active=1;
        Promise.resolve().then(job.work).then(value=>{
            active=0;
            advance();
            job.resolve(value);
        },error=>{
            active=0;
            advance();
            job.reject(error);
        });
    };
    return Object.freeze({
        run(work,{signal}={}){
            signal?.throwIfAborted();
            if(typeof work!=='function')
                return Promise.reject(new TypeError('视频处理任务必须是函数'));
            if(pending.length>=maxPending)
                return Promise.reject(queueFull());
            return new Promise((resolve,reject)=>{
                const job={work,resolve,reject,signal,abort:null};
                job.abort=()=>{
                    const index=pending.indexOf(job);
                    if(index<0)
                        return;
                    pending.splice(index,1);
                    reject(signal.reason);
                };
                signal?.addEventListener('abort',job.abort,{once:true});
                pending.push(job);
                advance();
            });
        },
        snapshot(){return {active,pending:pending.length};},
    });
}
