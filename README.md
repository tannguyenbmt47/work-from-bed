# Work From Bed

Điều khiển laptop Ubuntu từ điện thoại: xem màn hình, di chuột, gõ phím, cuộn trang, chỉnh âm lượng, khoá hoặc tắt máy. Điện thoại không cần cài app, chỉ cần mở trình duyệt.

## Yêu cầu

- Laptop chạy Linux với phiên đồ hoạ **X11** (trên Ubuntu: chọn "Ubuntu on Xorg" ở màn hình đăng nhập).
- Python 3.10 trở lên, kèm `python3-venv` (hoặc có sẵn [uv](https://docs.astral.sh/uv/)). Hoặc dùng Docker, xem bên dưới.
- Điện thoại có trình duyệt bất kỳ (Chrome, Safari, Firefox…).

## Cài đặt (một lần)

```bash
git clone https://github.com/tannguyenbmt47/work-from-bed.git
cd work-from-bed
./install.sh
```

Script tự cài thư viện vào `.venv`, thêm biểu tượng **Work From Bed** vào menu ứng dụng, chạy nền, rồi mở **bảng điều khiển** trên trình duyệt của laptop. Trong bảng điều khiển:

1. Quét mã QR bằng camera điện thoại.
2. Bật **Tự chạy khi đăng nhập** nếu muốn mở laptop là dùng được ngay.

Các lần sau, mở menu ứng dụng và chọn Work From Bed. Nếu đang chạy rồi thì chỉ mở lại bảng điều khiển.

Trên điện thoại, chọn **Thêm vào màn hình chính** trong menu trình duyệt để mở như một ứng dụng toàn màn hình. Xoay ngang điện thoại để màn hình laptop hiện to nhất.

## Bảng điều khiển

Địa chỉ: `http://localhost:8765/admin`. Chỉ mở được trên chính laptop; truy cập từ máy khác sẽ bị từ chối.

- Mã QR và địa chỉ cho từng cách kết nối (Wi-Fi nhà, Tailscale), mã kết nối để gõ tay.
- Danh sách điện thoại đang kết nối, kèm nút **Ngắt**. Điện thoại bị ngắt sẽ không tự kết nối lại.
- **Đổi mã kết nối**: mọi điện thoại bị ngắt và phải quét mã QR mới.
- Bật/tắt tự chạy khi đăng nhập, thêm biểu tượng vào menu, dừng Work From Bed.
- Nhật ký hoạt động: ai vừa kết nối, ai nhập sai mã.
- **Mở thử trên laptop này**: mở giao diện điện thoại ngay trên laptop để xem thử.

## Các cách kết nối

| Cách | Khi nào dùng |
|---|---|
| Cùng Wi-Fi | Điện thoại và laptop cùng mạng ở nhà. Không cần Internet, dữ liệu chỉ đi trong mạng nhà. |
| Tailscale | Ở ngoài nhà. Cài Tailscale trên điện thoại, đăng nhập cùng tài khoản với laptop. Kết nối được mã hoá. |
| `http://localhost:8765` | Mở trên chính laptop để thử giao diện. |

## Chạy bằng Docker

Không muốn cài Python lên máy thì dùng Docker. Chạy các lệnh này trong phiên đồ hoạ của laptop (không chạy qua SSH):

```bash
./docker.sh up              # lần đầu dựng image (khoảng 1 phút), chạy nền, mở bảng điều khiển
./docker.sh logs            # xem nhật ký
./docker.sh down            # dừng
./docker.sh autostart on    # tự chạy bản Docker mỗi khi đăng nhập (off để tắt)
```

- Bản Docker và bản thường dùng chung mã kết nối, chung cổng 8765. Chỉ chạy một bản mỗi lúc.
- Container dùng mạng của máy (`network_mode: host`). Lý do: Docker cài bằng snap có `/tmp` riêng, không gắn được socket màn hình `/tmp/.X11-unix`, nên container phải kết nối qua socket dạng abstract của Xorg.
- `./docker.sh up` chép cookie X11 của phiên đang đăng nhập cho container. Mỗi lần đăng nhập lại, phải chạy lại lệnh này. `autostart on` làm việc này tự động.
- Container tắt AppArmor (`apparmor=unconfined`) để gọi được D-Bus khi khoá màn hình. Cho máy ngủ, khởi động lại, tắt máy thì container nhờ systemd của người dùng chạy lệnh trên máy, nên không cần sudo.

## Chạy trong terminal

```bash
./run.sh                    # chạy và in mã QR ngay trong terminal
./run.sh --show             # in lại địa chỉ và mã QR
./run.sh --new-token        # đổi mã kết nối
./run.sh --autostart on     # bật tự chạy khi đăng nhập (off để tắt)
./run.sh --install          # thêm biểu tượng vào menu ứng dụng
```

Nhật ký khi chạy nền (từ menu hoặc tự chạy) nằm ở `~/.cache/work-from-bed.log`.

## Cách điều khiển

Chế độ **Touchpad** (mặc định) dùng như touchpad laptop:

| Cử chỉ | Tác dụng |
|---|---|
| Rê 1 ngón | Di chuột |
| Chạm 1 ngón | Click trái |
| Chạm 2 ngón | Click phải |
| Chạm, rồi chạm lại và kéo | Kéo thả, bôi đen chữ |
| Kéo 2 ngón | Cuộn (vuốt nhanh thì cuộn theo quán tính) |
| Chụm hoặc mở 2 ngón | Thu nhỏ, phóng to. Khi đã phóng to, khung nhìn tự đi theo chuột |
| Chạm 3 ngón | Click giữa |

Chế độ **Chạm trực tiếp**: chạm vào đâu click vào đó, giữ lâu để click phải, kéo 1 ngón để kéo thả.

Thanh công cụ còn có:

- **Trái / Phải**: giữ nút chuột, dùng ngón khác rê trên màn hình để kéo thả.
- **Gõ phím**: mở bàn phím điện thoại. Gõ tiếng Việt, gợi ý từ, vuốt phím cách để dời con trỏ đều dùng được.
- **Phím tắt**: Ctrl/Alt/Shift/Super, Esc, Tab, mũi tên, F1–F12, Ctrl+C/V/Z…, Alt+Tab, âm lượng, nhạc, độ sáng.
- **Cài đặt**: chọn màn hình (màn laptop hoặc màn rời, nếu có nhiều màn), chất lượng hình, tốc độ chuột, gửi cả đoạn văn bản, khoá màn hình, cho máy ngủ, khởi động lại, tắt máy.

## Lưu ý

- **Bộ gõ tiếng Việt trên laptop** (ibus-bamboo, Unikey…): chuyển về tiếng Anh khi gõ từ điện thoại, nếu không chữ sẽ bị bỏ dấu hai lần. Bàn phím điện thoại đã lo phần dấu.
- **Gập nắp laptop**: mặc định Ubuntu cho máy ngủ khi gập nắp, trừ lúc đang cắm màn hình rời. Muốn gập mà vẫn điều khiển được, sửa `/etc/systemd/logind.conf` thành `HandleLidSwitch=ignore` rồi khởi động lại máy.
- **Màn hình khoá**: vẫn gõ mật khẩu mở khoá được từ điện thoại.
- **Chỉ chạy trên phiên X11** ("Ubuntu on Xorg"). Phiên Wayland không cho phép chụp màn hình và giả lập chuột theo cách này.
- Không truyền âm thanh sang điện thoại.
- Nếu đã bật tường lửa `ufw`, mở cổng: `sudo ufw allow 8765/tcp`.

## Bảo mật

- Ai có mã kết nối là có toàn quyền điều khiển laptop. Đừng chia sẻ mã hay ảnh chụp mã QR. Lộ mã thì bấm **Đổi mã kết nối**.
- Nhập sai mã 5 lần thì địa chỉ IP đó bị chặn tạm thời, thời gian chặn tăng dần. Các lần nhập sai hiện trong nhật ký hoạt động.
- Bảng điều khiển chỉ nhận trình duyệt trên chính laptop. Trang web lạ không gửi lệnh thay được.
- Trong Wi-Fi ở nhà, dữ liệu đi qua HTTP không mã hoá. Ở Wi-Fi công cộng (quán cà phê, khách sạn), hãy kết nối qua Tailscale.
- Mã kết nối lưu ở `~/.config/work_from_bed/config.json`.

## Cấu trúc

| File | Vai trò |
|---|---|
| `server.py` | Web server: xác thực, nhận thao tác, gửi hình, bảng điều khiển |
| `capture.py` | Chụp màn hình, chỉ nén và gửi phần vừa thay đổi |
| `desktop.py` | Giả lập chuột, bàn phím qua X11 (XTest) |
| `static/index.html`, `app.js`, `style.css` | Giao diện trên điện thoại |
| `static/admin.*` | Bảng điều khiển trên laptop |
| `install.sh`, `launch.sh`, `run.sh` | Cài đặt, mở từ menu, chạy trong terminal |
| `Dockerfile`, `docker-compose.yml`, `docker.sh` | Chạy bằng Docker |
