/**
 * 内容阅读相关功能模块
 */
import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import PQueue from 'p-queue';
import { debounce, kebabCase } from 'lodash-es';
import { ContentType } from '@any-reader/rule-utils';
import { getContent } from '@/api';
import { saveChapterHistory } from '@/api/modules/chapter-history';
import { contentDecoder } from '@/api/modules/rule-manager';
import { useChaptersStore } from '@/stores/chapters';
import { useSettingStore, type ReadStyle } from '@/stores/setting';
import { useReadStore } from '@/stores/read';
import { useKeyboardShortcuts } from '@/hooks/useMagicKeys';
import { TTS } from '@/utils/tts';
import { base64 } from '@/api/modules/tts';
import { executeCommand } from '@/api/modules/vsc';

/**
 * 保存阅读历史记录的Hook
 */
function useSaveHistory(contentRef: Ref<HTMLElement>, options: Ref<any>) {
  const savePercentage = debounce(
    (params: any) => {
      saveChapterHistory(params);
    },
    400,
    {
      maxWait: 30000
    }
  );

  useEventListener(contentRef, 'scroll', () => {
    const { chapterPath, filePath, ruleId } = options.value;
    savePercentage({
      ruleId,
      filePath,
      chapterPath,
      percentage: Math.floor((contentRef.value.scrollTop / contentRef.value.scrollHeight) * 100000)
    });
  });
}

/**
 * 主题样式设置Hook
 */
export function useTheme(contentRef: Ref<HTMLElement>) {
  const settingStore = useSettingStore();

  watchEffect(
    () => {
      if (!contentRef.value) return;

      const cssVars: (keyof ReadStyle)[] = [
        'textOpacity',
        'sectionSpacing',
        'fontWeight',
        'font',
        'textColor',
        'backgroundColor',
        'fontSize',
        'lineHeight',
        'letterSpacing'
      ];
      for (const vssVar of cssVars) {
        const val = settingStore.data.readStyle[vssVar];
        typeof val !== 'undefined' && contentRef.value.parentElement!.style.setProperty('--' + kebabCase(vssVar), String(val));
      }
    },
    {
      flush: 'post'
    }
  );
}

/**
 * 内容阅读核心Hook
 */
export function useContent(contentRef: Ref<HTMLElement>) {
  const content = ref<string[]>([]);
  const contentType = ref<ContentType | undefined>(ContentType.NOVEL);
  const route = useRoute();
  const router = useRouter();
  const chaptersStore = useChaptersStore();
  const settingStore = useSettingStore();
  const readStore = useReadStore();
  const options = computed(() => route.query);
  const loading = ref(false);
  let contentDecoderTasks: PQueue | undefined;
  const _onUnmounted: (() => void)[] = [];
  _onUnmounted.push(() => {
    readStore.setPath('');
    readStore.setTitle('');
    readStore.setPreTitle('');
    readStore.setNextTitle('');
    if (contentDecoderTasks) contentDecoderTasks.clear();
  });
  onUnmounted(() => {
    _onUnmounted.forEach((fn) => fn());
  });

  useSaveHistory(contentRef, options);
  const tts = useTTS(contentRef, onNextChapter);
  let ttsStatus = false;

  const chapterPath = ref<string>('');

  /**
   * 获取上一章节路径
   */
  const lastChapter = computed<string>(() => {
    if (!chapterPath.value) return '';
    const idx = chaptersStore.chapters.findIndex((e: any) => e.chapterPath === chapterPath.value);
    const item: any = idx === 0 ? null : chaptersStore.chapters[idx - 1];
    readStore.setPreTitle(item?.name || '');
    return item?.chapterPath || '';
  });

  /**
   * 获取下一章节路径
   */
  const nextChapter = computed<string>(() => {
    if (!chapterPath.value) return '';
    const idx = chaptersStore.chapters.findIndex((e: any) => e.chapterPath === chapterPath.value) + 1;
    if (idx === 0) return '';
    const item: any = chaptersStore.chapters.length - 1 < idx ? null : chaptersStore.chapters[idx];
    readStore.setNextTitle(item?.name || '');
    return item?.chapterPath || '';
  });

  /**
   * 预加载章节内容
   */
  function preload(chapterPath: string) {
    const key = 'preload@' + chapterPath;
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1');
      getContent({
        ...route.query,
        chapterPath
      });
    }
  }

  /**
   * 初始化
   * @param noCache 是否不使用缓存
   */
  async function init(noCache = false) {
    const { chapterPath: _chapterPath, filePath, ruleId, percentage } = route.query as Record<string, string>;
    content.value = [];
    loading.value = true;
    const res = await getContent({
      ...route.query,
      noCache
    }).catch(() => {});
    loading.value = false;
    chapterPath.value = _chapterPath as string;
    chaptersStore.getChapters(filePath as string, ruleId as string).then(() => {
      const chapterInfo = chaptersStore.chapters.find((e) => e.chapterPath === route.query.chapterPath);
      readStore.setPath(chapterInfo?.chapterPath || '');
      readStore.setTitle(chapterInfo?.name || '');
      // 设置标题
      executeCommand({ command: 'any-reader.setTitle', data: [readStore.title] });

      if (lastChapter.value) {
        preload(lastChapter.value);
      }
      if (nextChapter.value) {
        preload(nextChapter.value);
      }
    });
    if (res?.code === 0) {
      const { contentType: _contentType, content: _content, contentDecoder: _contentDecoder } = res.data;
      contentType.value = _contentType;
      // 处理正文解密
      if (_contentDecoder) {
        if (contentDecoderTasks) {
          contentDecoderTasks.clear();
        } else {
          contentDecoderTasks = new PQueue({ concurrency: 4 });
        }
        content.value = new Array(_content.length).fill('');
        _content.forEach((url, i) => {
          contentDecoderTasks?.add(async () => {
            const res = await contentDecoder({
              content: url,
              ruleId: ruleId
            });
            if (res?.code === 0) {
              content.value[i] = res.data;
            }
          });
        });
        // 等待所有内容解密完成
        await contentDecoderTasks.onIdle();
      } else {
        content.value = _content || [];
      }
    }

    // 确保内容已经渲染完成后再设置滚动位置
    await nextTick();

    if (percentage && contentRef.value) {
      const scrollTop = contentRef.value.scrollHeight * (+percentage / 100000);
      contentRef.value.scrollTop = scrollTop;
    }

    if (ttsStatus) {
      tts.start();
    }
  }

  // 路由被改变
  watch(
    () => route.query,
    () => init(),
    {
      immediate: true,
      deep: true
    }
  );

  /**
   * 跳转到指定章节
   */
  function toChapter(chapterPath: string) {
    if (!chapterPath) return;
    router.replace({
      name: route.name as string,
      query: {
        ...route.query,
        percentage: 0,
        chapterPath
      }
    });
  }

  /**
   * 跳转到上一章
   */
  function onPrevChapter() {
    toChapter(lastChapter.value);
  }

  /**
   * 跳转到下一章
   */
  function onNextChapter() {
    toChapter(nextChapter.value);
  }

  /**
   * 向上翻页
   */
  function onPageUp() {
    contentRef.value.scrollTo({
      top: contentRef.value.scrollTop - contentRef.value.offsetHeight + 15,
      behavior: 'smooth'
    });
  }

  /**
   * 向下翻页
   */
  function onPageDown() {
    contentRef.value.scrollTo({
      top: contentRef.value.scrollTop + contentRef.value.offsetHeight - 15,
      behavior: 'smooth'
    });
  }

  // 监听热键
  useKeyboardShortcuts(
    {
      passive: false,
      target: contentRef,
      onEventFired: (e) => {
        e.preventDefault();
      }
    },
    (cmd: string) => {
      const cmdMap: any = {
        prevChapter: onPrevChapter,
        nextChapter: onNextChapter,
        pageUp: onPageUp,
        pageDown: onPageDown,
        tts: () => {
          ttsStatus = tts.startOrStop();
        }
      };
      cmdMap[cmd] && cmdMap[cmd]();
    }
  );

  return {
    init,
    settingStore,
    content,
    contentType,
    toChapter,
    lastChapter,
    nextChapter,
    onPageUp,
    onPageDown,
    onPrevChapter,
    onNextChapter,
    loading
  };
}

/**
 * 文本转语音Hook
 */
export function useTTS(contentRef: Ref<HTMLElement>, ended: () => void) {
  let tts: TTS | null;

  const route = useRoute();

  /**
   * 销毁TTS实例
   */
  function destroy() {
    if (tts) {
      tts.destroy();
      tts = null;
    }
  }

  watch(
    () => route.fullPath,
    () => {
      destroy();
    }
  );

  onDeactivated(destroy);
  onUnmounted(destroy);

  /**
   * 开始TTS
   */
  function start() {
    tts = new TTS(
      contentRef.value,
      (text: string) => {
        return base64({ text }).then((e) => e.data);
      },
      ended
    );
  }

  return {
    start,
    startOrStop() {
      if (!tts) {
        start();
        return true;
      } else {
        return tts.startOrStop();
      }
    }
  };
}
