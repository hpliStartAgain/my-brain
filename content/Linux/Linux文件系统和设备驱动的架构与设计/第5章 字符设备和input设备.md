# 第5章 字符设备和input设备

Linux操作系统把设备划分为字符设备和块设备（Linux操作系统的网络设备是特殊的，既不是字符设备，也不是块设备，而是一个单独的类型）。对从事Linux驱动的程序员来说，要么是字符设备驱动，要么是块设备驱动。

一个字符设备可以非常简单，以至于很多程序员把字符设备当作系统控制的一种手段，通过字符设备的I/O control函数与内核交换数据。但是实际上，Linux内核系统很多时候是把字符设备当作一个框架来用，这种用法就复杂多了。

那么什么是字符设备和块设备？本章我们分析字符设备。

## 5.1 文件如何变成设备

回顾第2章介绍的最简单文件系统aufs，通过 `aufs_get_inode` 为每个文件创建它的inode对象。可以看到，对文件和目录都有各自的文件操作函数和inode操作函数。但是默认情况下，我们用一个 `init_special_inode` 函数给对象赋值。

### 5.1.1 init_special_inode函数

通过 `init_special_inode` 函数使文件变成设备，字符设备和块设备开始浮出海面，所以有必要首先分析这个函数，它的代码如代码清单5-1所示。

**代码清单5-1 init_special_inode函数**

```c
void init_special_inode(struct inode *inode, umode_t mode, dev_t rdev)
{
    inode->i_mode = mode;
    if (S_ISCHR(mode)) {
        inode->i_fop = &def_chr_fops;
        inode->i_rdev = rdev;
    } else if (S_ISBLK(mode)) {
        inode->i_fop = &def_blk_fops;
        inode->i_rdev = rdev;
    } else if (S_ISFIFO(mode))
        inode->i_fop = &def_fifo_fops;
    else if (S_ISSOCK(mode))
        inode->i_fop = &bad_sock_fops;
    else
        printk(KERN_DEBUG "init_special_inode: bogus i_mode (%o)\n", mode);
}
```

这段代码很简单，如果是字符设备，它的文件操作结构指针被赋值为 `def_chr_fops`；如果是块设备，则被赋值为 `def_blk_fops`。同时inode的 `i_rdev` 被赋值为 `rdev`，这个 `rdev` 其实就是由主设备号和从设备号生成的设备号。

通过这个特别的函数，inode的文件函数指针 `i_fop` 被替换，从此inode不再是普通的文件inode，而是分别可以代表字符设备、块设备、fifo和socket的特殊inode。

### 5.1.2 def_chr_fops结构

本章重点分析为字符设备提供的 `def_chr_fops` 结构，它的代码如代码清单5-2所示。

**代码清单5-2 def_chr_fops结构**

```c
const struct file_operations def_chr_fops = {
    .open = chrdev_open,
};

int chrdev_open(struct inode * inode, struct file * filp)
{
    struct cdev *p;
    struct cdev *new = NULL;
    int ret = 0;
    spin_lock(&cdev_lock);
    p = inode->i_cdev;
    
    /* 如果字符设备不存在 */
    if (!p) {
        struct kobject *kobj;
        int idx;
        spin_unlock(&cdev_lock);
        /* 通过kobj_lookup查找字符设备的kobj结构 */
        kobj = kobj_lookup(cdev_map, inode->i_rdev, &idx);
        if (!kobj)
            return -ENXIO;
        /* 调用container方法,获得cdev对象 */
        new = container_of(kobj, struct cdev, kobj);
        spin_lock(&cdev_lock);
        /* 再次检查p */
        p = inode->i_cdev;
        if (!p) {
            /* 赋值.inode的字符设备指针指向发现的字符设备 */
            inode->i_cdev = p = new;
            inode->i_cindex = idx;
            list_add(&inode->i_devices, &p->list);
            new = NULL;
        } else if (!cdev_get(p))
            ret = -ENXIO;
    } else if (!cdev_get(p))
        ret = -ENXIO;
    spin_unlock(&cdev_lock);
    cdev_put(new);
    if (ret)
        return ret;
    /* 获得设备的函数指针,对input设备来说,就是input_fops */
    filp->f_op = fops_get(p->ops);
    if (!filp->f_op) {
        cdev_put(p);
        return -ENXIO;
    }
    /* 这个open函数就是input设备的input_open_file */
    if (filp->f_op->open) {
        /* 大内核锁 */
        lock_kernel();
        ret = filp->f_op->open(inode,filp);
        unlock_kernel();
    }
    if (ret)
        cdev_put(p);
    return ret;
}
```

`chrdev_open` 函数前面说明了，每次打开一个字符设备的时候，都调用这个函数。它首先根据设备号调用 `kobj_lookup` 搜索注册的字符设备对象，如果找到字符设备，执行字符设备的 `open` 函数，找不到则返回错误。

Linux系统提供了 `mknod` 程序，使用这个程序用户可以根据主从设备号创建特殊文件，比如字符设备文件或者块设备文件。从内核的角度分析，`mknod` 为特殊文件创建了一个inode结构和dentry结构，inode结构的成员包含主从设备号和设备类型，然后调用 `init_special_inode` 函数为设备文件的inode设置不同的函数指针。打开设备文件时，通过 `chrdev_open` 函数真正调用设备驱动本身的 `open` 函数，当然，前提是已经注册了设备驱动函数。

## 5.2 input设备的注册

为了正确理解和应用，需要一个典型的字符设备示例。本节直接从内核选择一个例子，就是input设备。这个设备不但典型，而且具有很大实用价值。input是一个虚拟的设备，在Linux系统中，键盘、鼠标、触摸屏和游戏杆都要由input设备统一管理。

input设备是个字符设备，它是如何注册设备驱动的？这要从input设备的初始化函数 `input_init` 开始。

### 5.2.1 主从设备号

Linux系统通过设备号来区分不同的设备。设备号由两部分组成：主设备号和从设备号。

下面摘录了系统定义的一些主设备号（来自 `include/linux/major.h`）。

```c
#define UNNAMED_MAJOR                   0
#define MEM_MAJOR                       1
#define RAMDISK_MAJOR                   1
#define FLOPPY_MAJOR                    2
#define PTY_MASTER_MAJOR                2
#define IDE0_MAJOR                      3
#define HD_MAJOR                        IDE0_MAJOR
#define PTY_SLAVE_MAJOR                 3
#define TTY_MAJOR                       4
#define TTYAUX_MAJOR                    5
#define LP_MAJOR                        6
#define VCS_MAJOR                       7
#define LOOP_MAJOR                      7
#define SCSI_DISK0_MAJOR                8
#define SCSI_TAPE_MAJOR                 9
#define MD_MAJOR                        9
#define MISC_MAJOR                      10
#define SCSI_CDROM_MAJOR                11
#define MUX_MAJOR                       11        
#define XT_DISK_MAJOR                   13
#define INPUT_MAJOR                     13
```

系统定义了多个主设备号，本节要讨论的input设备占第13号主设备号。从设备号区分归属于同一个主设备的独立设备。比如，系统中有几个硬盘，它们占用了不同的次设备号。

也许读者会想，input设备包括各种各样的输入设备。别说键盘、鼠标的不同，就是鼠标之间也有各种各样的型号，难道这些键盘、鼠标、游戏杆都用的同一个驱动？

这个问题，从内核的角度很容易理解。实际上，字符设备input是设备的一个聚合层，众多的驱动和设备被input封装，经过这个封装层之后，键盘和鼠标等设备就各行其是，分别由不同的驱动所控制。而且不仅仅input是一个封装层，在input之下，系统还提供了几个层次的封装。这是Linux内核设计的一个重要思想。在内核代码的阅读过程中，我们将发现越来越多的这种分层架构。这也是Linux内核设计向面向对象设计靠拢的一个标志，在本文的叙述中，也大量使用“对象”这个词来描述内核中各个层次生成的数据结构。以一个普通的键盘来说，因为键盘属于串口设备（假定，当然也有USB键盘等），所以内核要创建一个串口设备，同时安装相应的串口驱动。而键盘属于input设备范畴，它也要创建一个input设备，并安装相应的input驱动。

### 5.2.2 把input设备注册到系统

`input_init` 函数的作用是把input设备注册到系统，它的代码如代码清单5-3所示。

**代码清单5-3 input_init函数**

```c
static int __init input_init(void)
{
    int err;
    /* input要注册input类,这部分先跳过 */
    err = class_register(&input_class);
    if (err) {
        printk(KERN_ERR "input: unable to register input_dev class\n");
        return err;
    }
    /* 在proc目录下创建input相关的文件 */
    err = input_proc_init();
    if (err)
        goto fail1;
    err = register_chrdev(INPUT_MAJOR, "input", &input_fops);
    ...
}
```

`input_init` 函数最终调用 `register_chrdev` 函数来注册input驱动，它的代码如代码清单5-4所示。

**代码清单5-4 register_chrdev函数**

```c
int register_chrdev(unsigned int major, const char *name,
                    const struct file_operations *fops)
{
    struct char_device_struct *cd;
    struct cdev *cdev;
    char *s;
    int err = -ENOMEM;
    
    cd = __register_chrdev_region(major, 0, 256, name);
    if (IS_ERR(cd))
        return PTR_ERR(cd);
    
    /* 申请一个cdev对象 */
    cdev = cdev_alloc();
    if (!cdev)
        goto out2;
    cdev->owner = fops->owner;
    cdev->ops = fops;
    /* 设置字符设备kobj结构的名字 */
    kobject_set_name(&cdev->kobj, "%s", name);
    for (s = strchr(kobject_name(&cdev->kobj),'/'); s; s = strchr(s,'/'))
        *s = '!';
    /* cdev插入链表 */
    err = cdev_add(cdev, MKDEV(cd->major, 0), 256);
    ...
}
```

`register_chrdev` 函数实际执行了两个登记，一个是登记设备的区间，另一个登记是注册一个字符设备。首先分析设备区间的登记。

### 5.2.3 设备区间的登记

区间是主设备号和从设备号共同占有的一段空间，`register_chrdev` 函数要登记0～256的从设备号区间，这个区间之前不能被占用。登记区间通过 `__register_chrdev_region` 函数实现，它的代码如代码清单5-5所示。

**代码清单5-5 __register_chrdev_region函数**

```c
static struct char_device_struct *
__register_chrdev_region(unsigned int major, unsigned int baseminor,
                         int minorct, const char *name)
{
    struct char_device_struct *cd, **cp;
    int ret = 0;
    int i;
    
    cd = kzalloc(sizeof(struct char_device_struct), GFP_KERNEL);
    if (cd == NULL)
        return ERR_PTR(-ENOMEM);
    
    mutex_lock(&chrdevs_lock);
    
    /* 主设备号为0,说明这个设备没指定设备号,需要分配一个 */
    if (major == 0) {
        for (i = ARRAY_SIZE(chrdevs)-1; i > 0; i--) {
            if (chrdevs[i] == NULL)
                break;
        }
        if (i == 0) {
            ret = -EBUSY;
            goto out;
        }
        major = i;
        ret = major;
    }
    
    cd->major = major;
    cd->baseminor = baseminor;
    cd->minorct = minorct;
    strncpy(cd->name, name, 64);
    
    /* 根据主设备号计算索引,实际是主设备号除以255的余数 */
    i = major_to_index(major);
    /* 找一个未占用的区间 */
    for (cp = &chrdevs[i]; *cp; cp = &(*cp)->next)
        if ((*cp)->major > major ||
            ((*cp)->major == major && (*cp)->baseminor >= baseminor))
            break;
    if (*cp && (*cp)->major == major &&
        (*cp)->baseminor < baseminor + minorct) {
        ret = -EBUSY;
        goto out;
    }
    cd->next = *cp;
    *cp = cd;
    mutex_unlock(&chrdevs_lock);
    return cd;
out:
    mutex_unlock(&chrdevs_lock);
    kfree(cd);
    return ERR_PTR(ret);
}
```

1）`__register_chrdev_region` 函数第一部分首先创建一个 `char_device_struct` 结构，然后要考虑输入的主设备号为0的情况。这种情况下，要为字符设备分配一个主设备号。

分配主设备号的算法是从高到低遍历数组 `chrdevs`，如果发现某个主设备号为空，则分配给字符设备。`chrdevs` 是全局变量，它是个255个元素的指针数组，对应设备的主设备号。如果输入的主设备号大于255，则取其余数。这个结构数组保存了所有的主设备号和从设备号。

2）`__register_chrdev_region` 第二部分从数组 `chrdevs` 找到未占用的区间。首先通过主设备号索引获得结构 `char_device_struct`，然后遍历 `char_device_struct` 结构的单向链表，依次比较从设备号，找到一个合适的区间。最后将创建的字符设备结构 `cd` 链接到单向链表，完成字符设备区间的登记。

### 5.2.4 注册字符设备

返回 `register_chrdev` 函数，`cdev_add` 函数的功能是注册字符设备，它的代码如代码清单5-6所示。

**代码清单5-6 cdev_add函数**

```c
int cdev_add(struct cdev *p, dev_t dev, unsigned count)
{
    p->dev = dev;
    p->count = count;
    return kobj_map(cdev_map, dev, count, NULL, exact_match, exact_lock, p);
}
```

`cdev_add` 函数要把复合设备号（由主设备号和从设备号计算而来）和设备区间注册到系统，这是通过调用 `kobj_map` 函数实现的。

`kobj_map` 和前一节学习的 `kobj_lookup` 是同一组函数，目的就是通过系统的指针数组和链表管理字符设备，`kobj_map` 函数的代码如代码清单5-7所示。

**代码清单5-7 kobj_map函数**

```c
int kobj_map(struct kobj_map *domain, dev_t dev, unsigned long range,
             struct module *module, kobj_probe_t *probe,
             int (*lock)(dev_t, void *), void *data)
{
    /* 计算设备输入的range可能占用几个主设备号.对256这个range来说,只占用1个 */
    unsigned n = MAJOR(dev + range - 1) - MAJOR(dev) + 1;
    unsigned index = MAJOR(dev);
    unsigned i;
    struct probe *p;
    
    if (n > 255)
        n = 255;
    
    p = kmalloc(sizeof(struct probe) * n, GFP_KERNEL);
    if (p == NULL)
        return -ENOMEM;
    
    /* 为p赋值 */

```


## 5.3.2 匹配input管理的设备和驱动

input管理的设备和驱动是如何匹配的?这是 `input_match_device` 函数实现的功能,所以有必要了解它的代码,理清匹配的依据,如代码清单5-10所示.

**代码清单5-10** `input_match_device` 函数

```c
static struct input_device_id *input_match_device(struct input_handler *handler,
                                                    struct input_dev *dev)
{
  int i;
  for (; id->flags || id->driver_info; id++) {
      if (id->flags & INPUT_DEVICE_ID_MATCH_BUS)
          if (id->bustype != dev->id.bustype)
              continue;
      if (id->flags & INPUT_DEVICE_ID_MATCH_VENDOR)
          if (id->vendor != dev->id.vendor)
              continue;
      if (id->flags & INPUT_DEVICE_ID_MATCH_PRODUCT)
          if (id->product != dev->id.product)
              continue;
      if (id->flags & INPUT_DEVICE_ID_MATCH_VERSION)
          if (id->version != dev->id.version)
              continue;
      /* 逐一检查事件类型是否匹配 */
      MATCH_BIT(evbit,  EV_MAX);
      MATCH_BIT(keybit, KEY_MAX);
      MATCH_BIT(relbit, REL_MAX);
      MATCH_BIT(absbit, ABS_MAX);
      MATCH_BIT(mscbit, MSC_MAX);
      MATCH_BIT(ledbit, LED_MAX);
      MATCH_BIT(sndbit, SND_MAX);
      MATCH_BIT(ffbit,  FF_MAX);
      MATCH_BIT(swbit,  SW_MAX);
      return id;
  }
  return NULL;
}
```

`input_match_device` 函数逐一对比驱动的ID表和设备的ID表,检查它们的总线类型、制造商、产品号和版本,以及事件类型是否相等.

## 5.3.3 注册input设备

分析完 `input_register_handler`,可以返回 `input_register_device` 函数.这个函数作用是注册input设备,它的代码如代码清单5-11所示.

**代码清单5-11** `input_register_device` 函数

```c
int input_register_device(struct input_dev *dev)
{
  static atomic_t input_no = ATOMIC_INIT(0);
  struct input_handle *handle;
  struct input_handler *handler;
  struct input_device_id *id;
  const char *path;
  int error;

  set_bit(EV_SYN, dev->evbit);

  /* 初始化设备的timer */
  init_timer(&dev->timer);
  if (!dev->rep[REP_DELAY] && !dev->rep[REP_PERIOD]) {
      dev->timer.data = (long) dev;
      dev->timer.function = input_repeat_key;
      dev->rep[REP_DELAY] = 250;
      dev->rep[REP_PERIOD] = 33;
  }
    
  /* 设备加入input的设备列表 */
  INIT_LIST_HEAD(&dev->h_list);
  list_add_tail(&dev->node, &input_dev_list);   
```

`input_register_device` 函数第一部分是初始化设备,将设备加入总的input设备链表.这样,通过链表就可以遍历所有的input设备.同时初始化设备的timer.这个timer的作用是设置的定时时间到达,自动重复输入input设备的按键值.

```c
  /* 指定设备属于input类 */ 
  dev->cdev.class = &input_class;
  snprintf(dev->cdev.class_id, sizeof(dev->cdev.class_id),
           "input%ld", (unsigned long) atomic_inc_return(&input_no));
  error = class_device_add(&dev->cdev);
  if (error)
      return error;
  error = sysfs_create_group(&dev->cdev.kobj, &input_dev_attr_group);
  if (error)
      goto fail1;
  error = sysfs_create_group(&dev->cdev.kobj, &input_dev_id_attr_group);
  if (error)
      goto fail2;
  error = sysfs_create_group(&dev->cdev.kobj, &input_dev_caps_attr_group);
  if (error)
      goto fail3;
```

`input_register_device` 函数第二部分通过sysfs文件系统创建设备的属性文件.文件在系统根目录 `/sys/input/input*/` 里面.sysfs文件系统第4章已经介绍过,此处略过.为增加感性认识,读者可以比较一下创建的文件是否和代码的设计一致.

```c
  /* 省略输出设备名字的部分代码 */
  list_for_each_entry(handler, &input_handler_list, node)
       if (!handler->blacklist || !input_match_device(handler->blacklist, dev))
           if ((id = input_match_device(handler->id_table, dev)))
               if ((handle = handler->connect(handler, dev, id)))
                   input_link_handle(handle);
                   if (handler->start)
                       handler->start(handle);

  input_wakeup_procfs_readers();
}
```

`input_register_device` 第三部分的代码和 `input_register_handler` 函数最后的代码很像，不过这次是遍历所有的驱动，检查是否和设备匹配。匹配的算法同样是先检查驱动的黑名单，再检查驱动和设备的ID表是否适合。

> [!NOTE] input框架的设计动机
> 分析完input框架，引出了一个问题：内核为什么要加这样一个层次？所有的层次设计主要是为了复用代码，简化其他层次的工作量。input汇聚的设备，不管是键盘、鼠标还是游戏杆触摸屏，它们的公共特征就是截获用户的输入，并交给操作系统处理。所以input提供了重要的事件处理函数 `input_event`，通过这个函数上报用户输入（实际上输入到终端的input buffer）。那么具体设备的驱动（如键盘驱动），只要调用 `input_event` 就可以上报用户的按键输入，节省了设备驱动的工作量。

## 5.4 本章小结

内核驱动中，类似input这样的框架还有一些。例如，根目录下的 `sound/core/sound.c`，定义了一个字符设备来统一管理声音设备；目录 `drivers/video/fbmem.c`，同样定义了一个字符设备来管理frame buffer对象。这样的架构还有很多，这些相似的架构分析掌握一种就可以触类旁通，大大减少学习内核的时间。读者可以试着分析这些驱动，从而加强对Linux驱动架构的理解和掌握。

在这里，有必要串联一下知识点，帮助我们更全面地理解Linux设备和驱动的架构。回顾前文我们知道，[[设备配置表]]、[[总线]]和[[驱动]]是整个内核设备架构的三大层次。设备配置表描述了设备本身物理特性（以PCI设备为例），包括设备的寄存器信息和内存信息；而总线……（后续内容在本部分未提供，请参考上下文）