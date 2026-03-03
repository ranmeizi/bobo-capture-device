const axios = require('axios')
const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone')

dayjs.extend(utc);
dayjs.extend(timezone);

function sleep(timeout) {
    return new Promise(resolve => setTimeout(resolve, timeout))
}

// 提取消息关键字的正则
const checkReg = /<.+> .+ (got|executed|stole)/;

const killReg = /<.+> (.+) executed \[(.+)\]\(.+mob_id=(\d+)&.+\) at (.+)/;

const dropReg = /<.+> (.+) got \[(.+)\]\(.+item_id=(\d+)&.+\)/;

const stoleReg = /<.+> (.+) stole \[(.+)\]\(.+item_id=(\d+)&.+\)/;

function wrapCatchFunction(func) {
    return async function (...args) {
        try {
            return await func(...args);
        } catch (error) {
            console.error(error);
        }
    };
}

const TYPES = {
    executed: 0,
    got: 1,
    stole: 2,
};



/**
 * @type {import('cdp-client-tool').excuteFn}
 */
async function capture(ctx) {
    const browser = ctx.browser
    const logger = ctx.logger;

    const page = await browser.newPage();

    // 监听请求
    const subscriber = new RequestSubscriber(page);

    let news_smallest_ts = undefined;

    // 监听请求
    subscriber.on(
        'https://discord.com/api/v9/channels/1353165010582638713/messages',

        wrapCatchFunction(async (response) => {
            let data = await getBodyJson(response)

            if (!Array.isArray(data)) {
                return
            }

            const msgs = data.map((item) => {
                const typeMatch = item.content.match(checkReg)?.[1]
                const ts = dayjs.utc(item.timestamp).tz('Asia/Shanghai').valueOf()
                // @ts-ignore
                const type = TYPES[typeMatch]

                if (type === 0) {
                    // 提取关键信息
                    const res = item.content.match(killReg) || []
                    const [_, subject, object, objectId, map] = res

                    const note = {
                        ts,
                        type: 0,
                        key: `${ts}_${subject}_${objectId}`,
                        subject,
                        object,
                        objectId,
                        map,
                        origin: item.content,
                        utc: dayjs.utc(item.timestamp).valueOf(),
                    }

                    return {
                        ...item,
                        note
                    }
                } else if (type === 1) {

                    // 提取关键信息
                    const res = item.content.match(dropReg) || []
                    const [_, subject, object, objectId] = res

                    const note = {
                        ts,
                        type: 1,
                        key: `${ts}_${subject}_${objectId}`,
                        subject,
                        object,
                        objectId,
                        origin: item.content,
                        utc: dayjs.utc(item.timestamp).valueOf(),
                    }

                    return {
                        ...item,
                        note
                    }
                } else if (type === 2) {
                    // 提取关键信息
                    const res = item.content.match(stoleReg) || []
                    const [_, subject, object, objectId] = res

                    const note = {
                        ts,
                        type: 2,
                        key: `${ts}_${subject}_${objectId}`,
                        subject,
                        object,
                        objectId,
                        origin: item.content,
                        utc: dayjs.utc(item.timestamp).valueOf(),
                    }

                    return {
                        ...item,
                        note
                    }
                }
                return item

            })
            // @ts-ignore
            const sendData = msgs.filter(item => item.note).map(item => item.note)
            logger.info('发送数据', sendData)
            const res = await axios.post('https://boboan.net/api/momoro/ingamenews/push', sendData)

            if (res.data.code === '000000') {

                news_smallest_ts = sendData.reduce((prev, curr) => {
                    return Math.min(prev, curr.utc)
                }, sendData[0].utc)
            }
        })
    );

    // 获取最新时间
    const ts = await getLastestTs();

    // 打开页面
    await page.goto(
        'https://discord.com/channels/1188424174012731432/1353165010582638713',
    );

    // Remove the page's default timeout function
    await page.setDefaultNavigationTimeout(0);

    await sleep(5000);

    logger.info('打开页面');

    logger.info('等待加载完成');

    try {
        await page.waitForSelector('div [data-jump-section="global"]');
    } catch (e) {
        logger.error('waitForSelector 错误了');
        throw e
        // 终止
    }

    await sleep(2000);

    logger.info('最新时间:', ts, news_smallest_ts);

    while (!news_smallest_ts || ts < news_smallest_ts) {
        logger.info(`滚动, 抓取的数据最早ts:${news_smallest_ts},本次启动数据库最新时间:${ts}`);
        await scrollElement(page, `div [data-jump-section='global']`);
    }

    await sleep(1000);

    await page.close();

    return {
        ts,
        news_smallest_ts
    }
}

class RequestSubscriber {

    page;
    /**
     * @type {Record<string, Array<(response: any) => void>>}
     */
    subscribes = {};

    constructor(page) {
        this.page = page;
        this._init();
    }

    _init() {
        this.page.on('response', (response) => {
            const url = response.url();

            for (const [pattern, listeners] of Object.entries(this.subscribes)) {
                const reg = new RegExp(pattern);
                if (url.match(reg)) {
                    for (const listener of listeners) {
                        listener(response);
                    }
                }
            }
        });
    }

    on(pattern, listener) {
        if (!this.subscribes[pattern]) {
            this.subscribes[pattern] = [listener];
        } else {
            this.subscribes[pattern].push(listener);
        }

        return () => {
            this.un(pattern, listener);
        };
    }

    un(pattern, listener) {
        if (this.subscribes[pattern]) {
            this.subscribes[pattern] = this.subscribes[pattern].filter(
                (item) => item !== listener,
            );
            if (this.subscribes[pattern].length === 0) {
                delete this.subscribes[pattern];
            }
        }
    }
}

// 从接口获取最新时间
async function getLastestTs() {
    return axios.get('https://boboan.net/api/momoro/getLastestTs').then(res => res.data.data)
}
async function scrollElement(page, selector, duration = 1000) {
    // 执行滚动
    await page.evaluate(
        ({ selector }) => {
            const els = document.querySelectorAll(selector);

            for (let i = 0; i < els.length; i++) {
                // 找 scroller 元素
                const el = els[i];

                if (el.className.includes('scroller')) {
                    el.scrollBy({
                        top: -500,
                        behavior: 'smooth', // 关键：启用平滑滚动
                    });
                }
            }
        },
        { selector },
    );
    await sleep(duration);
}

async function getBodyJson(response) {
    try {
        // 如果传入的是 Puppeteer 的 Response 对象
        if (response && typeof response.json === 'function') {
            return await response.json();
        }

        // 如果以上都不匹配，返回 null
        return null;
    } catch (error) {
        logger.error('解析响应体为 JSON 时出错:', error);
        return null;
    }
}


module.exports = capture