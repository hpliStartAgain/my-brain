---
type: task
status: done
priority: P1
deadline: 2026-03-13
domain: 集群日常运维
lifecycle: routine
progress: "100"
started_date: 2026-03-11
completed_date: 2026-03-13
---

## 🎯 目标与验收标准
- [x] 调整内存参数，观察 进程资源占用情况。 ✅ 2026-03-25
- [x] 确保期间无业务报错。 ✅ 2026-03-25

## 📝 实施记录
```bash
sysctl -w vm.swappiness=1 -w vm.min_free_kbytes=1048576 && printf "vm.swappiness=1\nvm.min_free_kbytes=1048576\n" | sudo tee -a /etc/sysctl.conf && sysctl vm.swappiness vm.min_free_kbytes
```