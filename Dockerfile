FROM python:3.12-slim

# libxcb-*: mss chụp màn hình qua XCB và bộ nhớ chia sẻ MIT-SHM.
# dbus-bin: khoá màn hình, cho máy ngủ, tắt máy qua D-Bus (trong container không có systemctl/loginctl).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libxcb1 libxcb-randr0 libxcb-render0 libxcb-shm0 libxcb-xfixes0 dbus-bin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
COPY static ./static

ENV WFB_DOCKER=1 PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["python", "server.py", "--wait-display"]
