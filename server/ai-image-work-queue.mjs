// A single AI worker owns this queue. Waiting jobs hold no database connection.
export function createImageWorkQueue({concurrency=1,maxPending=64}={}) {
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>2)throw new Error('图片本地并发须为 1 或 2');
  let active=0;const pending=[];
  function advance(){
    while(active<concurrency&&pending.length){
      const job=pending.shift();active++;
      Promise.resolve().then(job.work).then(value=>{active--;advance();job.resolve(value);},error=>{active--;advance();job.reject(error);});
    }
  }
  return {
    run(work){
      if(pending.length>=maxPending)return Promise.reject(Object.assign(new Error('图片处理队列已满，请稍后重试'),{code:'AI_LISTING_LOCAL_QUEUE_FULL'}));
      return new Promise((resolve,reject)=>{pending.push({work,resolve,reject});advance();});
    },
    setConcurrency(value){
      if(!Number.isInteger(value)||value<1||value>2)throw new Error('图片本地并发须为 1 或 2');
      concurrency=value;advance();
    },
    snapshot(){return {active,pending:pending.length,concurrency};},
  };
}
